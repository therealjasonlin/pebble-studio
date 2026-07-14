# sitecustomize.py — Pebble Studio native-Windows fake-time shim for pebble-tool.
#
# WHY THIS EXISTS
# ---------------
# On the WSL/Linux track an LD_PRELOAD shim (vendor/timeshim/timeshim.c) fakes the
# clock for the ENTIRE qemu process tree, so pebble-tool's time.time() also returns
# the fake/custom time. On native Windows only the rebuilt qemu reads the fake clock
# (PEBBLE_FAKETIME_FILE); pebble-tool runs as a separate process on the REAL clock.
#
# pebble-tool's post_connect() (pebble_tool/commands/base.py) pushes
#   TimeMessage(SetUTC(unix_time=int(time.time()), ...))
# on EVERY connection. On modern PebbleOS that jams the firmware to the host's REAL
# time; qemu then re-jams the RTC back to the custom fake value → the watch animates
# the time change, reverts, and loops.
#
# FIX: this module is the Windows analog of the LD_PRELOAD shim. When
# PEBBLE_FAKETIME_FILE is set, it monkeypatches time.time()/localtime()/gmtime() to
# track the SAME fake clock qemu serves, so post_connect (and emucontrol/screenshot)
# push the CUSTOM time. Semantics mirror timeshim.c exactly:
#   control file (one line):  <target_unix_seconds|-> <rate>
#   fake = anchor_fake + (real_now - anchor_real) * rate
#   on (re-)read: anchor_real = real_now; anchor_fake = target (or real_now if "-")
# Absent/empty/unset control file => real time (no faking).
import os
import time as _time

_ctl = os.environ.get("PEBBLE_FAKETIME_FILE")
if _ctl:
    _real_time = _time.time
    _real_monotonic = _time.monotonic
    _real_localtime = _time.localtime
    _real_gmtime = _time.gmtime

    _st = {
        "anchor_real": _real_time(),
        "anchor_fake": _real_time(),  # until first read: fake == real
        "rate": 1.0,
        "mtime": None,
        "last_check": 0.0,
    }

    def _refresh():
        # Re-read the control file when its mtime changes, throttled to 200ms —
        # mirrors timeshim.c so a long-lived process (emu-control) re-anchors too.
        mono = _real_monotonic()
        if mono - _st["last_check"] < 0.2:
            return
        _st["last_check"] = mono
        try:
            mtime = os.stat(_ctl).st_mtime
        except OSError:
            return
        if mtime == _st["mtime"]:
            return
        _st["mtime"] = mtime
        try:
            with open(_ctl, "r") as f:
                parts = f.read().split()
        except OSError:
            return
        if len(parts) < 2:
            return
        tgt, rate_s = parts[0], parts[1]
        real = _real_time()
        _st["anchor_real"] = real
        _st["anchor_fake"] = real if tgt == "-" else float(tgt)
        try:
            _st["rate"] = float(rate_s)
        except ValueError:
            _st["rate"] = 1.0

    def _fake_time():
        _refresh()
        return _st["anchor_fake"] + (_real_time() - _st["anchor_real"]) * _st["rate"]

    def _fake_localtime(secs=None):
        return _real_localtime(_fake_time() if secs is None else secs)

    def _fake_gmtime(secs=None):
        return _real_gmtime(_fake_time() if secs is None else secs)

    _time.time = _fake_time
    _time.localtime = _fake_localtime
    _time.gmtime = _fake_gmtime


# --- Pebble Studio simulated location & weather ---------------------------------
# Python exposes sys.argv as ["-m", ...] while sitecustomize runs for
# `python -m pypkjs`, so argv alone cannot identify the process. Inspect the
# current process command line as a POSIX fallback, while leaving every other
# pebble-tool command untouched.
import subprocess as _subprocess
import sys as _sys

_sim_file = os.environ.get("PEBBLE_SIM_ENV_FILE")


def _is_pypkjs_process():
    if any("pypkjs" in str(arg).lower() for arg in _sys.argv):
        return True

    try:
        command = _subprocess.check_output(
            ["ps", "-p", str(os.getpid()), "-o", "command="],
            text=True,
            stderr=_subprocess.DEVNULL,
        ).lower()
        return "pypkjs" in command
    except Exception:
        return False


if _sim_file and _is_pypkjs_process():
    try:
        from gevent import monkey as _monkey
        _monkey.patch_all()
        import pebble_studio_sim
        pebble_studio_sim.install(_sim_file)
    except Exception as _sim_err:  # pragma: no cover - defensive
        _sys.stderr.write("pebble_studio_sim install failed: %r\n" % (_sim_err,))
