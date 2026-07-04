/* Self-test target for the macOS time-shim (analog of Windows probe.exe).
 *
 * Prints the current time() as Unix seconds, once. The controller runs this
 * THROUGH the shim (DYLD_INSERT_LIBRARIES + PEBBLE_FAKETIME_OFFSET=86400) and
 * checks the printed value is ≈ now+86400 — proving the inject+interpose path
 * works end-to-end. A dedicated probe is required because Apple system binaries
 * (/bin/date, python3, …) are SIP-restricted, so DYLD_INSERT_LIBRARIES is
 * stripped for them and they cannot self-test the shim.
 */
#include <stdio.h>
#include <time.h>

int main(void) {
    printf("%ld\n", (long)time(NULL));
    return 0;
}
