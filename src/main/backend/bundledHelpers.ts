/**
 * winHelpers.ts — deploy the persistent input helper (pb-input-helper.py) the
 * windows-native driver runs with the bundled interpreter. Written to disk under
 * a per-user dir at startup so the driver can invoke it by absolute path.
 *
 * (No tz/time helper here: custom time over the watch protocol can't work on the
 * native track — pypkjs is single-client and emu-control holds the watch
 * connection, so the SetUTC handshake times out. The input helper only sends
 * qemu-relay packets, which need no watch handshake, so it works.)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persistent input helper: connects ONCE to the running emulator's pypkjs
 * websocket (port = argv[1]) and turns one-line stdin commands into the same
 * QemuButton/QemuTap relay packets `pebble emu-button`/`emu-tap` send. Holding
 * the connection open is what removes the per-press process-spawn latency.
 *
 * It ALSO handles `screenshot <out_path>`: a BACKLIGHT-FREE framebuffer grab
 * over the watch protocol (libpebble2 Screenshot service, endpoint 8000 — bright
 * regardless of the LCD backlight). This is layered on the SAME websocket the
 * input relay uses: a libpebble2 PebbleConnection is wrapped around the existing
 * transport LAZILY (only on the first screenshot), so the latency-critical
 * button/tap path is never altered — button sends remain raw WebSocketRelayQemu
 * writes exactly as before. The grab runs under a watchdog so a hung framebuffer
 * read can't wedge the helper.
 *
 * NOTE: the framebuffer screenshot path is UNVERIFIED LIVE (the emulator was
 * closed when this was authored) — pypkjs is single-client, so wrapping the
 * relay socket in a PebbleConnection read loop is the one piece that needs a real
 * watch to confirm. Every failure mode prints `ERR ...`; the renderer falls back
 * to the existing VNC-canvas + backlight screenshot, so a failure here is benign.
 */
export const INPUT_HELPER_PY = `import sys, time, threading, json, uuid
from libpebble2.communication.transports.websocket import WebsocketTransport, MessageTargetPhone
from libpebble2.communication.transports.websocket.protocol import WebSocketRelayQemu, WebSocketTimelinePin, InsertPin, DeletePin
from libpebble2.communication.transports.qemu.protocol import QemuPacket, QemuButton, QemuTap

_SUNLIGHT_LUT = {
    (0,0,0):(0,0,0),(0,0,85):(0,30,65),(0,0,170):(0,67,135),(0,0,255):(0,104,202),
    (0,85,0):(43,74,44),(0,85,85):(39,81,79),(0,85,170):(22,99,141),(0,85,255):(0,125,206),
    (0,170,0):(94,152,96),(0,170,85):(92,155,114),(0,170,170):(87,165,162),(0,170,255):(76,180,219),
    (0,255,0):(142,227,145),(0,255,85):(142,230,158),(0,255,170):(138,235,192),(0,255,255):(132,245,241),
    (85,0,0):(74,22,27),(85,0,85):(72,39,72),(85,0,170):(64,72,138),(85,0,255):(47,107,204),
    (85,85,0):(86,78,54),(85,85,85):(84,84,84),(85,85,170):(79,103,144),(85,85,255):(65,128,208),
    (85,170,0):(117,154,100),(85,170,85):(117,157,118),(85,170,170):(113,166,164),(85,170,255):(105,181,221),
    (85,255,0):(158,229,148),(85,255,85):(157,231,160),(85,255,170):(155,236,194),(85,255,255):(149,246,242),
    (170,0,0):(153,53,63),(170,0,85):(152,62,90),(170,0,170):(149,86,148),(170,0,255):(143,116,210),
    (170,85,0):(157,91,77),(170,85,85):(157,96,100),(170,85,170):(154,112,153),(170,85,255):(149,135,213),
    (170,170,0):(175,160,114),(170,170,85):(174,163,130),(170,170,170):(171,171,171),(170,170,255):(167,186,226),
    (170,255,0):(201,232,157),(170,255,85):(201,234,167),(170,255,170):(199,240,200),(170,255,255):(195,249,247),
    (255,0,0):(227,84,98),(255,0,85):(226,88,116),(255,0,170):(225,106,163),(255,0,255):(222,131,220),
    (255,85,0):(230,110,107),(255,85,85):(230,114,124),(255,85,170):(227,127,167),(255,85,255):(225,148,223),
    (255,170,0):(241,170,134),(255,170,85):(241,173,147),(255,170,170):(239,181,184),(255,170,255):(236,195,235),
    (255,255,0):(255,238,171),(255,255,85):(255,241,181),(255,255,170):(255,246,211),(255,255,255):(255,255,255),
}
_SUNLIGHT_SNAP = [(0,85,170,255)[min(3,(v+42)//85)] for v in range(256)]

# Lazy framebuffer-screenshot state. The PebbleConnection that drives the
# libpebble2 Screenshot service is built once, on the first 'screenshot' command,
# wrapping the SAME transport the button relay already uses. None until then so
# the pure-input path pays nothing.
_pebble = None
_pebble_lock = threading.Lock()


def _get_pebble(transport):
    # Build (once) and return a connected PebbleConnection over the live relay
    # socket. run_async() spawns the read loop + fetch_watch_info() handshake the
    # Screenshot service needs. Raises on failure — caller turns it into 'ERR'.
    global _pebble
    with _pebble_lock:
        if _pebble is None:
            from libpebble2.communication import PebbleConnection
            p = PebbleConnection(transport)
            p.run_async()  # background read loop; also fetches watch info
            _pebble = p
        return _pebble


def _grab_png(transport, out_path):
    # Framebuffer grab → PNG with Pebble sunlight colour correction (matches
    # pebble-tool's _correct_colours; only invoked when the UI toggle is on).
    from libpebble2.services.screenshot import Screenshot
    import png
    pebble = _get_pebble(transport)
    rows = Screenshot(pebble).grab_image()  # list of RGB8 row bytearrays
    if not rows:
        raise RuntimeError('no screenshot data')
    height = len(rows)
    width = len(rows[0]) // 3
    snap = _SUNLIGHT_SNAP
    lut = _SUNLIGHT_LUT
    corrected = []
    for row in rows:
        out = bytearray(len(row))
        for x in range(0, len(row), 3):
            cr, cg, cb = lut[(snap[row[x]], snap[row[x+1]], snap[row[x+2]])]
            out[x] = cr; out[x+1] = cg; out[x+2] = cb
        corrected.append(out)
    png.from_array(corrected, mode='RGB;8', info={'width': width, 'height': height}).save(out_path)


def do_screenshot(transport, out_path, timeout=8.0):
    # Run the grab in a worker so a wedged framebuffer read can't block the input
    # loop forever; the watchdog turns a hang into a clean 'ERR timeout'.
    result = {}

    def worker():
        try:
            _grab_png(transport, out_path)
            result['ok'] = True
        except Exception as e:
            result['err'] = str(e)

    t = threading.Thread(target=worker)
    t.daemon = True
    t.start()
    t.join(timeout)
    if t.is_alive():
        sys.stdout.write('ERR screenshot timed out\\n')
    elif result.get('ok'):
        sys.stdout.write('OK %s\\n' % out_path)
    else:
        sys.stdout.write('ERR %s\\n' % result.get('err', 'screenshot failed'))
    sys.stdout.flush()


def main():
    port = int(sys.argv[1])
    transport = WebsocketTransport('ws://localhost:%d/' % port)
    transport.connect()

    BTN = {'back': QemuButton.Button.Back, 'up': QemuButton.Button.Up,
           'select': QemuButton.Button.Select, 'down': QemuButton.Button.Down}
    AXIS = {'x': QemuTap.Axis.X, 'y': QemuTap.Axis.Y, 'z': QemuTap.Axis.Z}

    def send(data):
        packet = QemuPacket(data=data)
        packet.serialise()
        transport.send_packet(
            WebSocketRelayQemu(protocol=packet.protocol, data=data.serialise()),
            target=MessageTargetPhone())

    SANDBOX_UUID = 'a1b2c3d4-0000-0000-0000-000000000001'

    def pin_guid(pin_id):
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, '%s.pin.developer.getpebble.com' % pin_id))

    def send_pin(pin_id, unix_time, title):
        iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(unix_time))
        now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        pin = {
            'id': pin_id, 'guid': pin_guid(pin_id), 'time': iso,
            'createTime': now_iso, 'updateTime': now_iso, 'topicKeys': [],
            'source': 'sdk', 'dataSource': 'sandbox-uuid:%s' % SANDBOX_UUID,
            'layout': {'type': 'genericPin', 'title': title,
                       'tinyIcon': 'system://images/NOTIFICATION_FLAG'},
        }
        transport.send_packet(WebSocketTimelinePin(data=InsertPin(json=json.dumps(pin))),
                              target=MessageTargetPhone())

    def send_unpin(pin_id):
        transport.send_packet(WebSocketTimelinePin(data=DeletePin(uuid=pin_guid(pin_id))),
                              target=MessageTargetPhone())

    sys.stdout.write('ready\\n')
    sys.stdout.flush()
    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        try:
            cmd = parts[0]
            if cmd in ('click', 'hold'):
                mask = 0
                for b in parts[1:]:
                    mask |= BTN.get(b, 0)
                send(QemuButton(state=mask))
                if cmd == 'click':
                    time.sleep(0.08)
                    send(QemuButton(state=0))
            elif cmd == 'release':
                send(QemuButton(state=0))
            elif cmd == 'tap':
                d = parts[1] if len(parts) > 1 else 'x+'
                axis = AXIS.get(d[0], QemuTap.Axis.X)
                direction = 1 if d.endswith('+') else -1
                send(QemuTap(axis=axis, direction=direction))
            elif cmd == 'screenshot':
                # Path may contain spaces — everything after the verb is the path.
                out_path = line.split(None, 1)[1].strip() if len(parts) > 1 else ''
                if out_path:
                    do_screenshot(transport, out_path)
                else:
                    sys.stdout.write('ERR no output path\\n')
                    sys.stdout.flush()
            elif cmd == 'pin':
                # pin <id> <unix_time> <title...>
                pin_id = parts[1]
                unix_time = int(parts[2])
                rest = line.split(None, 3)
                title = rest[3].strip() if len(rest) > 3 else 'Sample Pin'
                send_pin(pin_id, unix_time, title)
                sys.stdout.write('OK pin %s\\n' % pin_id)
                sys.stdout.flush()
            elif cmd == 'unpin':
                send_unpin(parts[1])
                sys.stdout.write('OK unpin\\n')
                sys.stdout.flush()
        except Exception as e:
            # Input errors go to stderr (fire-and-forget); a screenshot error is
            # reported on stdout by do_screenshot, so report any stray failure
            # there too so the renderer's pending screenshot request can resolve.
            sys.stderr.write('input-helper error: %s\\n' % e)
            sys.stderr.flush()
            if parts and parts[0] in ('screenshot', 'pin', 'unpin'):
                sys.stdout.write('ERR %s\\n' % e)
                sys.stdout.flush()


main()
`;

export interface DeployedHelpers {
  /** Absolute path to the deployed persistent input helper. */
  inputHelperPath: string;
}

/**
 * Write the input helper script into `dir` (created if missing) and return its
 * absolute path. Idempotent — overwrites with the current source each launch so
 * an app update re-deploys a fresh helper.
 */
export function deployWinHelpers(dir: string): DeployedHelpers {
  mkdirSync(dir, { recursive: true });
  const inputHelperPath = join(dir, "pb-input-helper.py");
  writeFileSync(inputHelperPath, INPUT_HELPER_PY, "utf8");
  return { inputHelperPath };
}
