#!/usr/bin/env python3
"""Apply the native-Windows POSIX-ism patches to an installed pebble-tool + pypkjs.

Usage:  python apply-pebble-tool-patches.py <site-packages-dir>

Idempotent: re-running is a no-op. Fails loudly if an expected anchor is missing
(so a pebble-tool version bump can't silently skip a patch). See
docs/build/pebble-tool-windows-patches.md for the rationale of each patch.

Covers (validated Phase 1b, 2026-06-13/14):
  1+2  emulator.py  - liveness via tasklist; SIGKILL/os.kill via taskkill shim
  4    manager.py   - SDKs/current symlink -> directory junction
  7    websocket.py - NamedTemporaryFile re-open (close before re-open) + import os
  8    sdk/__init__.py - add_tools_to_path: no /var/tmp symlink on win; os.pathsep
  9    emulator.py  - spawn qemu/pypkjs/websockify with CREATE_NO_WINDOW (no stray
                     terminal windows) instead of the POSIX-only start_new_session
  10   emulator.py  - bind qemu serial/gdb/monitor/vnc + websockify to 127.0.0.1
  11   websocket.py - bind the pypkjs WSGIServer to 127.0.0.1
  14   runtime.py   - JS event loop survives a non-JSError in a queued callback
                     (a Clay config round-trip otherwise wedges showConfiguration
                     => "No config page" on every later open). Logs the traceback.
  15   websocket.py - per-socket send lock + resilient broadcast(): fixes the
                     gevent "socket already used by another greenlet" collision
                     between the JS-runtime config-URL broadcast and watch traffic.
  16   websocket.py - broadcast send timeout (1.5s) = THE Clay re-open fix's safety
                     net. A non-draining client (e.g. a mis-behaving websocket
                     consumer) whose socket buffer fills would block ws.send
                     forever, freezing the JS runtime => "No config page". The real
                     fix is the input helper draining (winHelpers.ts); this drops
                     any still-stuck client so the runtime never freezes.
(Patches 9-11 remove the Windows Defender firewall prompts for qemu-pebble.exe and
 python.exe, and the trio of console windows, by keeping every emulator listener on
 loopback and every child windowless. readline is handled by installing pyreadline3.)
"""
import sys, os

def patch_file(path, replacements):
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    orig = src
    for name, old, new, sentinel in replacements:
        if sentinel in src:
            print(f"  [skip] {name} (already applied)")
            continue
        if old not in src:
            raise SystemExit(f"ERROR: anchor for '{name}' not found in {path}. "
                             f"pebble-tool layout changed; update the patch.")
        src = src.replace(old, new)
        print(f"  [apply] {name}")
    if src != orig:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)

def main(sp):
    emulator = os.path.join(sp, "pebble_tool", "sdk", "emulator.py")
    manager  = os.path.join(sp, "pebble_tool", "sdk", "manager.py")
    sdkinit  = os.path.join(sp, "pebble_tool", "sdk", "__init__.py")
    wsock    = os.path.join(sp, "pypkjs", "runner", "websocket.py")
    runtime  = os.path.join(sp, "pypkjs", "javascript", "runtime.py")
    browser  = os.path.join(sp, "pebble_tool", "util", "browser.py")

    print(f"emulator.py:")
    patch_file(emulator, [
        ("emulator.py shim",
         'logger = logging.getLogger("pebble_tool.sdk.emulator")',
         'logger = logging.getLogger("pebble_tool.sdk.emulator")\n'
         '\n'
         '# --- Native-Windows compat (Pebble Studio win port) ---\n'
         'if sys.platform == "win32":\n'
         '    if not hasattr(signal, "SIGKILL"):\n'
         '        signal.SIGKILL = signal.SIGTERM\n'
         '    def _win_os_kill(pid, sig):\n'
         '        if sig == 0:\n'
         '            return\n'
         '        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],\n'
         '                       capture_output=True)\n'
         '    os.kill = _win_os_kill\n'
         '# ------------------------------------------------------',
         "_win_os_kill"),
        ("emulator.py _is_pid_running (both)",
         '        try:\n'
         '            os.kill(pid, 0)\n'
         '        except OSError as e:\n'
         '            if e.errno == 3:\n'
         '                return False\n'
         '            else:\n'
         '                raise\n'
         '        return True',
         '        if sys.platform == "win32":\n'
         '            out = subprocess.run(\n'
         '                ["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],\n'
         '                capture_output=True, text=True,\n'
         '            ).stdout\n'
         '            return (\'"%d"\' % pid) in out\n'
         '        try:\n'
         '            os.kill(pid, 0)\n'
         '        except OSError as e:\n'
         '            if e.errno == 3:\n'
         '                return False\n'
         '            else:\n'
         '                raise\n'
         '        return True',
         'tasklist'),
        # Patch 9 — windowless child spawns. Extend the win-compat shim with a
        # _CHILD_POPEN_KW that uses CREATE_NO_WINDOW (+ CREATE_NEW_PROCESS_GROUP)
        # on Windows, else start_new_session=True. Anchored to the end of the
        # shim block inserted by the first patch above (so order matters).
        ("emulator.py child popen flags",
         '    os.kill = _win_os_kill\n'
         '# ------------------------------------------------------',
         '    os.kill = _win_os_kill\n'
         '    # Spawn the emulator children (qemu, pypkjs, websockify) WITHOUT a\n'
         '    # console window. start_new_session is a POSIX no-op here, so without\n'
         '    # this each console-subsystem child pops its own terminal when the\n'
         '    # launching python has no console. CREATE_NO_WINDOW gives the child a\n'
         '    # hidden console (inherited by its children); CREATE_NEW_PROCESS_GROUP\n'
         '    # keeps a stray Ctrl+C aimed at the parent from tearing it down.\n'
         '    _CHILD_POPEN_KW = {\n'
         '        "creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,\n'
         '    }\n'
         'else:\n'
         '    _CHILD_POPEN_KW = {"start_new_session": True}\n'
         '# ------------------------------------------------------',
         "_CHILD_POPEN_KW"),
        # Patch 9 (cont.) — route every child spawn through _CHILD_POPEN_KW.
        ("emulator.py start_new_session -> _CHILD_POPEN_KW",
         'start_new_session=True)',
         '**_CHILD_POPEN_KW)',
         "**_CHILD_POPEN_KW)"),
        # Patch 10 — keep qemu's listeners on loopback (no firewall prompt). Use
        # "localhost" (dual-stack 127.0.0.1 + ::1), NOT the "127.0.0.1" literal:
        # pebble-tool connects to these via ('localhost', port), and on Windows
        # localhost resolves to ::1 first; an IPv4-only bind makes that connect
        # fall back after ~2s, so _wait_for_qemu misses the firmware's one-shot
        # boot marker and the boot stalls forever.
        ("emulator.py qemu tcp loopback",
         '"tcp::{},{}".format(',
         '"tcp:localhost:{},{}".format(',
         "tcp:localhost:"),
        # Loopback VNC. NOTE: this qemu-pebble build rejects the IPv4-literal
        # form `-vnc 127.0.0.1:1` ("Failed to find an available port") but
        # accepts `localhost:1`, which binds display 1 (port 5901) on both
        # 127.0.0.1 and [::1] — what websockify (localhost:5901) proxies to.
        ("emulator.py qemu vnc loopback",
         'command.extend(["-vnc", ":1"])',
         'command.extend(["-vnc", "localhost:1"])',
         '"-vnc", "localhost:1"'),
        # Patch 10 (cont.) — websockify listens on loopback only.
        ("emulator.py websockify loopback",
         "'6080',",
         "'127.0.0.1:6080',",
         "'127.0.0.1:6080'"),
        # Patch 17 — QEMU snapshot restore. When PEBBLE_QEMU_INCOMING is set (the
        # full "file:C:/..." migration URI), append `-incoming <uri>` to the qemu
        # argv so the guest boots by loading a saved VM migration stream instead of
        # cold-booting. Studio sets this env for a SINGLE restore spawn only; when
        # it is absent the block is inert, so every other path (cold boot, wipe)
        # is unchanged. Appended last (just before env prep) so it is the final
        # argv addition regardless of board.
        ("emulator.py qemu incoming restore",
         '        # Prepare environment with bundled dylibs for macOS\n'
         '        env = os.environ.copy()',
         '        # Pebble Studio (win port) patch 17: restore from a QEMU snapshot when\n'
         '        # PEBBLE_QEMU_INCOMING is set (the full "file:C:/..." migration URI). Studio\n'
         '        # sets it for a single restore spawn only; absent => a normal cold boot, so\n'
         '        # this is inert on every other path (wipe, non-restore launches). Appended\n'
         '        # last so the guest starts paused and loads the migration stream on launch.\n'
         '        _incoming = os.environ.get("PEBBLE_QEMU_INCOMING")\n'
         '        if _incoming:\n'
         '            command.extend(["-incoming", _incoming])\n'
         '\n'
         '        # Prepare environment with bundled dylibs for macOS\n'
         '        env = os.environ.copy()',
         "PEBBLE_QEMU_INCOMING"),
        # Patch 17b — restore-aware boot wait. The normal _wait_for_qemu blocks on
        # the firmware's ONE-SHOT serial boot marker, which a restored guest never
        # re-emits; and a migration stream saved from a paused source (the manager
        # does HMP `stop` before `migrate`) restores PAUSED — qemu preserves the
        # source runstate in the stream's global_state section, so autostart does
        # not apply. Without this patch a restore boot hangs in _wait_for_qemu, the
        # state file is never written, and Studio times out + cold-boots on every
        # launch (restore would NEVER work). When PEBBLE_QEMU_INCOMING is set, wait
        # on the HMP monitor instead: poll `info status` until the incoming
        # migration finishes (runstate leaves "inmigrate"), send `cont` to resume
        # the paused guest, and verify "running". Any failure raises ToolError so
        # the launch fails CLEANLY and Studio's boot retry invalidates the bundle
        # and cold-boots. The cold path (env absent) is byte-identical.
        ("emulator.py restore-aware _wait_for_qemu",
         '    def _wait_for_qemu(self):\n'
         '        logger.info("Waiting for the firmware to boot.")',
         '    def _mon_cmd(self, sock, cmd, deadline):\n'
         '        # Pebble Studio patch 17b: one HMP command -> output up to the prompt.\n'
         '        sock.sendall(cmd + b"\\n")\n'
         '        buf = b""\n'
         '        while time.time() < deadline:\n'
         '            try:\n'
         '                data = sock.recv(4096)\n'
         '            except socket.timeout:\n'
         '                continue\n'
         '            if not data:\n'
         '                raise ToolError("Emulator restore failed (monitor closed).")\n'
         '            buf += data\n'
         '            if b"(qemu)" in buf:\n'
         '                return buf\n'
         '        raise ToolError("Emulator restore timed out (monitor unresponsive).")\n'
         '\n'
         '    def _wait_for_qemu_restore(self):\n'
         '        # Pebble Studio patch 17b: snapshot-restore readiness. A restored\n'
         '        # guest never re-emits the serial boot marker the normal wait blocks\n'
         '        # on, and a paused-source stream restores PAUSED — so wait for the\n'
         '        # incoming migration on the monitor, resume, verify "running".\n'
         '        logger.info("Waiting for snapshot restore.")\n'
         '        deadline = time.time() + 30\n'
         '        sock = None\n'
         '        while time.time() < deadline:\n'
         '            try:\n'
         '                sock = socket.create_connection((\'localhost\', self.qemu_monitor_port), timeout=1)\n'
         '                break\n'
         '            except socket.error:\n'
         '                # Fail fast if qemu already died (a corrupt/stale stream is\n'
         '                # rejected at load and the process exits).\n'
         '                if not self._is_pid_running(self.qemu_pid):\n'
         '                    post_event("qemu_launched", success=False, reason="restore_qemu_died")\n'
         '                    raise ToolError("Emulator restore failed (qemu exited during load).")\n'
         '                time.sleep(0.3)\n'
         '        if sock is None:\n'
         '            post_event("qemu_launched", success=False, reason="restore_no_monitor")\n'
         '            raise ToolError("Emulator restore timed out (no monitor).")\n'
         '        try:\n'
         '            sock.settimeout(2)\n'
         '            buf = b""\n'
         '            while time.time() < deadline and b"(qemu)" not in buf:\n'
         '                try:\n'
         '                    data = sock.recv(4096)\n'
         '                except socket.timeout:\n'
         '                    continue\n'
         '                if not data:\n'
         '                    raise ToolError("Emulator restore failed (monitor closed).")\n'
         '                buf += data\n'
         '            # Wait out the incoming migration: runstate reads "paused\n'
         '            # (inmigrate)" until the stream finishes loading.\n'
         '            status = b""\n'
         '            while time.time() < deadline:\n'
         '                status = self._mon_cmd(sock, b"info status", deadline)\n'
         '                if b"inmigrate" not in status:\n'
         '                    break\n'
         '                time.sleep(0.1)\n'
         '            # Resume the paused guest (no-op when already running).\n'
         '            if b"running" not in status:\n'
         '                self._mon_cmd(sock, b"cont", deadline)\n'
         '                status = self._mon_cmd(sock, b"info status", deadline)\n'
         '            if b"running" not in status:\n'
         '                post_event("qemu_launched", success=False, reason="restore_not_running")\n'
         '                raise ToolError("Emulator restore did not resume the guest.")\n'
         '        finally:\n'
         '            try:\n'
         '                sock.close()\n'
         '            except socket.error:\n'
         '                pass\n'
         '        post_event("qemu_launched", success=True)\n'
         '        logger.info("Firmware restored from snapshot.")\n'
         '\n'
         '    def _wait_for_qemu(self):\n'
         '        if os.environ.get("PEBBLE_QEMU_INCOMING"):\n'
         '            self._wait_for_qemu_restore()\n'
         '            return\n'
         '        logger.info("Waiting for the firmware to boot.")',
         "_wait_for_qemu_restore"),
    ])

    print(f"manager.py:")
    patch_file(manager, [
        ("manager.py set_current_sdk junction",
         '        try:\n'
         '            os.unlink(self._current_path)\n'
         '        except (OSError, TypeError):\n'
         '            pass\n'
         '        os.symlink(path, self._current_path)',
         '        link = self._current_path\n'
         '        if sys.platform == "win32":\n'
         '            try:\n'
         '                if os.path.isdir(link):\n'
         '                    os.rmdir(link)\n'
         '                elif os.path.lexists(link):\n'
         '                    os.unlink(link)\n'
         '            except OSError:\n'
         '                pass\n'
         '            import _winapi\n'
         '            _winapi.CreateJunction(path, link)\n'
         '            return\n'
         '        try:\n'
         '            os.unlink(link)\n'
         '        except (OSError, TypeError):\n'
         '            pass\n'
         '        os.symlink(path, link)',
         "_winapi.CreateJunction"),
    ])

    print(f"sdk/__init__.py:")
    patch_file(sdkinit, [
        ("sdk/__init__.py import sys",
         "__author__ = 'katharine'\n\nimport os\n",
         "__author__ = 'katharine'\n\nimport os\nimport sys\n",
         "import sys"),
        ("sdk/__init__.py add_tools_to_path",
         '        os.environ[\'PATH\'] = "{}:{}".format(os.path.join(get_persist_dir(), "SDKs", sdk_version(), "toolchain", "arm-none-eabi", "bin"), os.environ[\'PATH\'])\n'
         '\n'
         '        # Create symlink from /tmp/pebble-sdk to persist directory\n'
         '        tmp_link = "/var/tmp/pebble-sdk"\n'
         '        target = get_persist_dir()\n'
         '        if not (os.path.islink(tmp_link) and os.readlink(tmp_link) == target):\n'
         '            if os.path.lexists(tmp_link):\n'
         '                os.unlink(tmp_link)\n'
         '            os.symlink(target, tmp_link)\n'
         '\n'
         '        os.environ[\'PATH\'] = "{}:{}".format(os.path.join(tmp_link, "SDKs", sdk_version(), "toolchain", "moddable-tools"), os.environ[\'PATH\'])\n'
         '        os.environ[\'MODDABLE\'] = os.path.join(tmp_link, "SDKs", sdk_version(), "toolchain", "moddable")\n'
         '        extra_path = os.environ.get(\'PEBBLE_EXTRA_PATH\')\n'
         '        if extra_path:\n'
         '            os.environ[\'PATH\'] = "{}:{}".format(extra_path, os.environ[\'PATH\'])',
         '        sep = os.pathsep\n'
         '        os.environ[\'PATH\'] = "{}{}{}".format(os.path.join(get_persist_dir(), "SDKs", sdk_version(), "toolchain", "arm-none-eabi", "bin"), sep, os.environ[\'PATH\'])\n'
         '\n'
         '        if sys.platform == "win32":\n'
         '            base = get_persist_dir()\n'
         '        else:\n'
         '            tmp_link = "/var/tmp/pebble-sdk"\n'
         '            target = get_persist_dir()\n'
         '            if not (os.path.islink(tmp_link) and os.readlink(tmp_link) == target):\n'
         '                if os.path.lexists(tmp_link):\n'
         '                    os.unlink(tmp_link)\n'
         '                os.symlink(target, tmp_link)\n'
         '            base = tmp_link\n'
         '\n'
         '        os.environ[\'PATH\'] = "{}{}{}".format(os.path.join(base, "SDKs", sdk_version(), "toolchain", "moddable-tools"), sep, os.environ[\'PATH\'])\n'
         '        os.environ[\'MODDABLE\'] = os.path.join(base, "SDKs", sdk_version(), "toolchain", "moddable")\n'
         '        extra_path = os.environ.get(\'PEBBLE_EXTRA_PATH\')\n'
         '        if extra_path:\n'
         '            os.environ[\'PATH\'] = "{}{}{}".format(extra_path, sep, os.environ[\'PATH\'])',
         "sep = os.pathsep"),
    ])

    print(f"pypkjs/runner/websocket.py:")
    patch_file(wsock, [
        ("websocket.py import os",
         "import argparse\nimport json\nimport logging\nimport ssl",
         "import argparse\nimport json\nimport logging\nimport os\nimport ssl",
         "\nimport os\nimport ssl"),
        ("websocket.py NamedTemporaryFile",
         '        def go_do_install():\n'
         '            with tempfile.NamedTemporaryFile() as f:\n'
         '                f.write(message)\n'
         '                f.flush()\n'
         '                try:\n'
         '                    self.load_pbws([f.name], cache=True)\n'
         '                    AppInstaller(self.pebble.pebble, f.name, blobdb_client=self.pebble.blobdb).install()\n'
         '                except:\n'
         '                    try:\n'
         '                        ws.send(bytearray([0x05, 0x00, 0x00, 0x00, 0x01]))\n'
         '                    except WebSocketError:\n'
         '                        pass\n'
         '                    raise\n'
         '                else:\n'
         '                    try:\n'
         '                        ws.send(bytearray([0x05, 0x00, 0x00, 0x00, 0x00]))\n'
         '                    except WebSocketError:\n'
         '                        pass',
         '        def go_do_install():\n'
         '            f = tempfile.NamedTemporaryFile(delete=False)\n'
         '            try:\n'
         '                f.write(message)\n'
         '                f.flush()\n'
         '                f.close()\n'
         '                try:\n'
         '                    self.load_pbws([f.name], cache=True)\n'
         '                    AppInstaller(self.pebble.pebble, f.name, blobdb_client=self.pebble.blobdb).install()\n'
         '                except:\n'
         '                    try:\n'
         '                        ws.send(bytearray([0x05, 0x00, 0x00, 0x00, 0x01]))\n'
         '                    except WebSocketError:\n'
         '                        pass\n'
         '                    raise\n'
         '                else:\n'
         '                    try:\n'
         '                        ws.send(bytearray([0x05, 0x00, 0x00, 0x00, 0x00]))\n'
         '                    except WebSocketError:\n'
         '                        pass\n'
         '            finally:\n'
         '                try:\n'
         '                    os.unlink(f.name)\n'
         '                except OSError:\n'
         '                    pass',
         "delete=False"),
        # Patch 11 — bind the pypkjs phone websocket to loopback only. The app
        # connects via ws://localhost; a 0.0.0.0 bind makes Windows Defender
        # prompt to allow python.exe on the network.
        ("websocket.py WSGIServer loopback",
         'pywsgi.WSGIServer(("", self.port)',
         'pywsgi.WSGIServer(("127.0.0.1", self.port)',
         '("127.0.0.1", self.port)'),
        # Patch 15 (a) — make gevent.lock importable for the per-socket send lock.
        ("websocket.py import gevent.lock",
         "import gevent\nfrom gevent import pywsgi",
         "import gevent\nimport gevent.lock\nfrom gevent import pywsgi",
         "import gevent.lock"),
        # Patch 15 (b) — THE Clay re-open root cause. broadcast() does ws.send()
        # from whichever greenlet calls it; it is called BOTH from the JS runtime
        # (open_config_page broadcasting a large ~98KB Clay config URL, which
        # blocks/yields mid-send) AND from the pebble in/outbound handlers
        # broadcasting the watchface's constant traffic. Two concurrent ws.send()
        # on one socket raise gevent's uncaught "This socket is already used by
        # another greenlet" AssertionError -> the config-URL broadcast aborts so
        # Studio never receives the URL ("No config page"), and pre-patch-14 it
        # also killed the JS runtime. A per-socket send lock serializes sends so
        # the big config send and watch-traffic sends take turns.
        ("websocket.py per-socket send lock",
         "    def __init__(self, ws):\n"
         "        self.ws = ws\n"
         "        self.authed = False\n"
         "\n"
         "    def send(self, message):\n"
         "        self.ws.send(message)\n",
         "    def __init__(self, ws):\n"
         "        self.ws = ws\n"
         "        self.authed = False\n"
         "        self._send_lock = gevent.lock.Semaphore()\n"
         "\n"
         "    def send(self, message):\n"
         "        # Pebble Studio patch 15: serialize sends per socket so the JS\n"
         "        # runtime's large Clay config-URL broadcast and the watch-traffic\n"
         "        # broadcasts can't collide on one socket (gevent 'already used by\n"
         "        # another greenlet'), which otherwise aborts the broadcast and\n"
         "        # drops the Clay URL => 'No config page' on rapid re-opens.\n"
         "        with self._send_lock:\n"
         "            self.ws.send(message)\n",
         "_send_lock"),
        # Patch 15 (c) — defense in depth: one socket's send error must never
        # abort the whole broadcast loop (so the other clients, incl. Studio's
        # Clay socket, still get the frame) nor propagate to the caller.
        ("websocket.py broadcast resilient",
         "                try:\n"
         "                    ws.send(message)\n"
         "                except (WebSocketError, ssl.SSLError):\n"
         "                    to_remove.append(i)\n",
         "                try:\n"
         "                    ws.send(message)\n"
         "                except (WebSocketError, ssl.SSLError):\n"
         "                    to_remove.append(i)\n"
         "                except Exception:\n"
         "                    # Pebble Studio patch 15: never let one socket's send\n"
         "                    # error abort the broadcast to the others or bubble up.\n"
         "                    to_remove.append(i)\n",
         "never let one socket's send"),
        # Patch 16 — bound each broadcast send with a timeout (defense in depth on
        # top of the input helper now draining its socket — see winHelpers.ts). A
        # client that cannot absorb a frame within 1.5s is not draining; its full
        # socket buffer would otherwise block ws.send FOREVER, freezing pypkjs's
        # single JS-runtime greenlet so showConfiguration stops firing => Clay
        # "No config page" after a few opens. Drop the stuck client instead.
        ("websocket.py broadcast send timeout",
         "                try:\n"
         "                    ws.send(message)\n"
         "                except (WebSocketError, ssl.SSLError):\n"
         "                    to_remove.append(i)\n"
         "                except Exception:\n"
         "                    # Pebble Studio patch 15: never let one socket's send\n"
         "                    # error abort the broadcast to the others or bubble up.\n"
         "                    to_remove.append(i)\n",
         "                try:\n"
         "                    with gevent.Timeout(1.5):\n"
         "                        ws.send(message)\n"
         "                except gevent.Timeout:\n"
         "                    # Patch 16: client can't absorb this frame in 1.5s =>\n"
         "                    # not draining; a blocked send freezes the JS runtime\n"
         "                    # greenlet and wedges Clay. Drop the stuck client.\n"
         "                    try:\n"
         "                        ws.close()\n"
         "                    except Exception:\n"
         "                        pass\n"
         "                    to_remove.append(i)\n"
         "                except (WebSocketError, ssl.SSLError):\n"
         "                    to_remove.append(i)\n"
         "                except Exception:\n"
         "                    # Pebble Studio patch 15: never let one socket's send\n"
         "                    # error abort the broadcast to the others or bubble up.\n"
         "                    to_remove.append(i)\n",
         "with gevent.Timeout(1.5)"),
    ])

    print(f"pypkjs/javascript/runtime.py:")
    # Patch 14 — JS event-loop resilience. event_loop() only caught
    # (v8.JSError, JSRuntimeException) per queued callback; ANY other exception
    # (e.g. a Clay config round-trip raising a Python/struct/gevent error) broke
    # the for-loop, ran run()'s finally (shutdown + group.kill -> "JS finished"),
    # and left self.js pointing at a DEAD queue. do_config() then enqueued
    # showConfiguration into nothing => no openURL => no AppConfigURL broadcast =>
    # Studio timed out with "No config page" on EVERY subsequent open until the
    # app's JS was relaunched. (Matches the user's "works 1-2x, then consistently
    # fails on rapid Clay re-opens".) Catch broad exceptions, log the traceback
    # (broadcast as a 0x02 log frame so it's visible), and keep servicing the
    # queue. GreenletExit/LoopExit are NOT Exception subclasses raised by fn(),
    # so stop()/kill() and the outer LoopExit handler still work unchanged.
    patch_file(runtime, [
        ("runtime.py event_loop resilience",
         '                try:\n'
         '                    fn(*args, **kwargs)\n'
         '                except (v8.JSError, JSRuntimeException) as e:\n'
         '                    self.log_output("Error running asynchronous JavaScript:")\n'
         '                    self.log_output(e.stackTrace)\n',
         '                try:\n'
         '                    fn(*args, **kwargs)\n'
         '                except (v8.JSError, JSRuntimeException) as e:\n'
         '                    self.log_output("Error running asynchronous JavaScript:")\n'
         '                    self.log_output(e.stackTrace)\n'
         '                except Exception:\n'
         '                    # Pebble Studio (win port) patch 14: a non-JS error in a\n'
         '                    # queued callback must NOT kill the runtime (that wedges\n'
         '                    # Clay/showConfiguration -> "No config page" forever).\n'
         '                    import traceback as _pbtb\n'
         '                    self.log_output("Unhandled exception in JS event loop (continuing):")\n'
         '                    self.log_output(_pbtb.format_exc())\n',
         "Unhandled exception in JS event loop"),
    ])

    print("util/browser.py:")
    # Patch 12 — emu-control starts a sensor-page HTTP server (and the app-config
    # command an HTTPServer) bound to ('', port) = all interfaces, which is the
    # remaining Windows Defender prompt for python.exe. Bind both to loopback;
    # Pebble Studio reaches them via localhost and does not use the phone/QR LAN path.
    patch_file(browser, [
        ("browser.py sensor-page loopback",
         "BaseHTTPServer.HTTPServer(('', self.port), SensorPageHandler)",
         "BaseHTTPServer.HTTPServer(('127.0.0.1', self.port), SensorPageHandler)",
         "('127.0.0.1', self.port), SensorPageHandler"),
        ("browser.py app-config loopback",
         "BaseHTTPServer.HTTPServer(('', port), AppConfigHandler)",
         "BaseHTTPServer.HTTPServer(('127.0.0.1', port), AppConfigHandler)",
         "('127.0.0.1', port), AppConfigHandler"),
    ])
    print("sitecustomize.py (fake-time shim):")
    write_sitecustomize(sp)

    print("All patches applied/verified.")


# Patch 13 — native-Windows fake-time shim for pebble-tool. The WSL track fakes
# the clock for the whole process tree via LD_PRELOAD; on native Windows only qemu
# reads PEBBLE_FAKETIME_FILE, so pebble-tool's post_connect would push the host's
# REAL time via SetUTC and fight qemu's custom clock (modern fw: time-change
# animation loops + reverts). This sitecustomize makes pebble-tool's clock track
# the SAME fake time, so post_connect/emucontrol/screenshot push the custom time.
# See docs + memory custom-time-revert-postconnect-clobber.
_SITECUSTOMIZE = '''\
# sitecustomize.py — Pebble Studio native-Windows fake-time shim for pebble-tool.
# Windows analog of vendor/timeshim/timeshim.c. When PEBBLE_FAKETIME_FILE is set,
# monkeypatch time.time/localtime/gmtime to track the fake clock qemu serves so
# pebble-tool's SetUTC pushes the CUSTOM time, not the host's real time.
#   control file (one line):  <target_unix_seconds|-> <rate>
#   fake = anchor_fake + (real_now - anchor_real) * rate
import os
import time as _time

_ctl = os.environ.get("PEBBLE_FAKETIME_FILE")
if _ctl:
    _real_time = _time.time
    _real_monotonic = _time.monotonic
    _real_localtime = _time.localtime
    _real_gmtime = _time.gmtime
    _st = {"anchor_real": _real_time(), "anchor_fake": _real_time(),
           "rate": 1.0, "mtime": None, "last_check": 0.0}

    def _refresh():
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
# Independent of the fake-clock block above. When PEBBLE_SIM_ENV_FILE is set, install
# the requests/pygeoip patches so weather watchfaces resolve a fixed location and get
# synthetic weather offline. Failure here must never break the interpreter.
_sim_file = os.environ.get("PEBBLE_SIM_ENV_FILE")
if _sim_file:
    try:
        import pebble_studio_sim
        # Deferred: must NOT import requests/ssl here (before pypkjs's gevent
        # monkey-patch) or every real HTTPS XHR fails with RecursionError.
        pebble_studio_sim.install_deferred(_sim_file)
    except Exception as _sim_err:  # pragma: no cover - defensive
        import sys as _sys
        _sys.stderr.write("pebble_studio_sim install failed: %r\\n" % (_sim_err,))
'''


def write_sitecustomize(sp):
    path = os.path.join(sp, "sitecustomize.py")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            if "PEBBLE_FAKETIME_FILE" in f.read():
                print("  [skip] sitecustomize.py (already present)")
                return
    with open(path, "w", encoding="utf-8") as f:
        f.write(_SITECUSTOMIZE)
    print("  [apply] sitecustomize.py")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply-pebble-tool-patches.py <site-packages-dir>")
    main(sys.argv[1])
