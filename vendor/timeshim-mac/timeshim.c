/* Runtime-controllable fake-realtime shim for qemu-pebble — macOS (Mach-O).
 *
 * This is the macOS analog of vendor/timeshim/timeshim.c (Linux LD_PRELOAD) and
 * vendor/timeshim-win/ (Windows injected DLL). It is force-loaded into the
 * qemu-pebble process via DYLD_INSERT_LIBRARIES and fakes the host wall clock,
 * which is the only lever qemu-pebble's RTC honors. Same env + control-file
 * contract as the other two shims, so the app's setFakeTime path is unchanged.
 *
 * macOS-specific design (empirically established):
 *   - Hooks are installed via the __DATA,__interpose section (dyld interposing),
 *     which works under the default two-level namespace — no flat namespace.
 *   - The REAL wall clock is read from the UN-interposed clock_gettime_nsec_np().
 *     We must NOT dlsym(RTLD_NEXT, "clock_gettime"): on macOS dyld's own dlsym
 *     calls clock_gettime, which re-enters this interposer before the real
 *     pointer is cached → infinite recursion (hang) or a NULL-deref (segfault).
 *     Both failure modes were reproduced in testing. clock_gettime_nsec_np is a distinct
 *     symbol we do NOT interpose, so calling it here is safe and recursion-free.
 *
 * Env vars:
 *   PEBBLE_FAKETIME_OFFSET  initial offset seconds (default 0)
 *   PEBBLE_FAKETIME_RATE    initial rate (default 1.0)
 *   PEBBLE_FAKETIME_FILE    control file, re-read when mtime changes
 *                           (checked at most every 200ms of real time)
 *   PEBBLE_FAKETIME_LOG     optional: append a diagnostic line on each ctl apply
 *
 * Control file format (one line):  <target_unix_seconds|-> <rate>
 *   "1577836800 1"  -> jump fake clock to 2020-01-01T00:00:00Z, run 1x
 *   "- 0"           -> keep current fake time, freeze
 *   "- 60"          -> keep current fake time, run 60x
 */
#include <time.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <pthread.h>

static int64_t anchor_real = 0;   /* real CLOCK_REALTIME ns at the anchor */
static int64_t anchor_fake = 0;   /* fake ns at the anchor */
static double  rate = 1.0;
static const char *ctl_file = NULL;
static const char *log_file = NULL;
static time_t  ctl_mtime = 0;
static int64_t last_check_mono = 0;
static int ready = 0;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

/* Real clocks via the UN-interposed *_np entry points (see header: no dlsym). */
static int64_t real_realtime_ns(void) { return (int64_t)clock_gettime_nsec_np(CLOCK_REALTIME); }
static int64_t real_mono_ns(void)     { return (int64_t)clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

static int64_t fake_now_locked(int64_t real) {
    return anchor_fake + (int64_t)((double)(real - anchor_real) * rate);
}

static void maybe_log_locked(void) {
    if (!log_file) return;
    FILE *f = fopen(log_file, "a");
    if (!f) return;
    fprintf(f, "pebble-faketime: base=%lld rate=%.3f\n",
            (long long)(anchor_fake / 1000000000LL), rate);
    fclose(f);
}

static void check_ctl_file(int64_t real) {
    if (!ctl_file) return;
    int64_t mono = real_mono_ns();
    if (mono - last_check_mono < 200000000LL) return;  /* 200ms throttle */
    last_check_mono = mono;
    struct stat st;
    if (stat(ctl_file, &st) != 0) return;
    if (st.st_mtime == ctl_mtime) return;
    ctl_mtime = st.st_mtime;
    FILE *f = fopen(ctl_file, "r");
    if (!f) return;
    char tgt[64]; double r;
    if (fscanf(f, "%63s %lf", tgt, &r) == 2) {
        int64_t cur_fake = fake_now_locked(real);
        anchor_real = real;
        anchor_fake = (tgt[0] == '-' && tgt[1] == '\0')
                      ? cur_fake
                      : (int64_t)atoll(tgt) * 1000000000LL;
        rate = r;
        maybe_log_locked();
    }
    fclose(f);
}

static void init_once(void) {
    if (ready) return;
    pthread_mutex_lock(&lock);
    if (!ready) {
        const char *o = getenv("PEBBLE_FAKETIME_OFFSET");
        const char *r = getenv("PEBBLE_FAKETIME_RATE");
        ctl_file = getenv("PEBBLE_FAKETIME_FILE");
        log_file = getenv("PEBBLE_FAKETIME_LOG");
        if (ctl_file && ctl_file[0] == '\0') ctl_file = NULL;
        if (log_file && log_file[0] == '\0') log_file = NULL;
        anchor_real = real_realtime_ns();
        anchor_fake = anchor_real + (o ? (int64_t)atoll(o) * 1000000000LL : 0);
        rate = r ? atof(r) : 1.0;
        ready = 1;
    }
    pthread_mutex_unlock(&lock);
}

static int64_t fake_now(void) {
    int64_t real = real_realtime_ns();
    pthread_mutex_lock(&lock);
    check_ctl_file(real);
    int64_t f = fake_now_locked(real);
    pthread_mutex_unlock(&lock);
    return f;
}

/* --- interposed entry points ------------------------------------------------
 * Only CLOCK_REALTIME (the host wall clock qemu's RTC reads) is faked; every
 * other clock id passes through to the real (un-interposed) monotonic source so
 * qemu's timers are unaffected. */

static int my_clock_gettime(clockid_t clk, struct timespec *ts) {
    init_once();
    if (clk == CLOCK_REALTIME) {
        int64_t f = fake_now();
        ts->tv_sec = f / 1000000000LL;
        ts->tv_nsec = f % 1000000000LL;
        return 0;
    }
    uint64_t ns = clock_gettime_nsec_np(clk);
    ts->tv_sec = (time_t)(ns / 1000000000ULL);
    ts->tv_nsec = (long)(ns % 1000000000ULL);
    return 0;
}

static int my_gettimeofday(struct timeval *tv, void *tz) {
    (void)tz;
    init_once();
    if (tv) {
        int64_t f = fake_now();
        tv->tv_sec = f / 1000000000LL;
        tv->tv_usec = (f % 1000000000LL) / 1000;
    }
    return 0;
}

static time_t my_time(time_t *t) {
    init_once();
    time_t r = (time_t)(fake_now() / 1000000000LL);
    if (t) *t = r;
    return r;
}

__attribute__((used)) static struct { const void *r; const void *o; }
_ip_clock_gettime __attribute__((section("__DATA,__interpose"))) =
    { (const void *)my_clock_gettime, (const void *)clock_gettime };
__attribute__((used)) static struct { const void *r; const void *o; }
_ip_gettimeofday __attribute__((section("__DATA,__interpose"))) =
    { (const void *)my_gettimeofday, (const void *)gettimeofday };
__attribute__((used)) static struct { const void *r; const void *o; }
_ip_time __attribute__((section("__DATA,__interpose"))) =
    { (const void *)my_time, (const void *)time };
