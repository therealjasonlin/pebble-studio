import GIF from "gif.js";
import { FrameBudget } from "../../capture/gifRecorder.js";
import {
  grabUpscaled,
  rgbaToBlob,
  applyCircularMask,
} from "../captureCanvas.js";
import type { RgbaImage } from "../../capture/upscale.js";
import { applySunlightLut } from "../sunlightLut.js";

/** Magenta key color used as the transparent index in round GIFs. */
const GIF_TRANSPARENT_COLOR = 0xff00ff;

/**
 * Hard cap (seconds) on any single GIF recording. Sized to allow the longest
 * 15s preset to complete; manual recordings are bounded by this too so files
 * can't grow unbounded.
 */
const GIF_MAX_SECONDS = 15;

/** Pref key: briefly wake the backlight during a capture (default ON when unset). */
const BACKLIGHT_CAPTURE_KEY = "pebble-studio:backlight-capture";

/** Beat (ms) to let the backlight rise before grabbing an instant screenshot. */
const BACKLIGHT_RISE_MS = 250;

/**
 * GIF pre-roll (ms): wake the backlight and let it fully rise BEFORE the first
 * frame is grabbed, so the recording is bright from frame one (a touch longer
 * than the screenshot rise since a GIF's opening frames are the most visible).
 */
const GIF_BACKLIGHT_PREROLL_MS = 400;

/**
 * GIF post-roll (ms): keep the capture backlight held for a short beat AFTER the
 * user presses Stop, then release. Guarantees the final frames (grabbed right
 * before Stop) stay lit and the release never races an in-flight last grab, so
 * the whole recording is uniformly bright.
 */
const GIF_BACKLIGHT_POSTROLL_MS = 700;

export class CaptureBar {
  readonly el: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly durationSelect: HTMLSelectElement;
  private readonly shotBtn: HTMLButtonElement;
  private readonly recBtn: HTMLButtonElement;
  private readonly lightBtn: HTMLButtonElement;
  private readonly status: HTMLSpanElement;

  private recording = false;
  private gif: InstanceType<typeof GIF> | null = null;
  private recTimer: ReturnType<typeof setInterval> | null = null;
  /** Pending post-roll backlight release from stopRecord(); tracked so a new
   * capture started within the post-roll window can cancel it before it releases
   * the hold mid-capture (which would dim the new frames — the very thing the
   * hold prevents). */
  private backlightReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Auto-clear timer for a transient status message (errors / not-running). */
  private statusClearTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once the backlight-free framebuffer screenshot has failed this session,
   * so later shots skip straight to the canvas path instead of re-timing-out. */
  private framebufferShotUnavailable = false;

  constructor(
    private readonly getHost: () => HTMLElement | null,
    private readonly isRound: () => boolean = () => false,
    private readonly getPlatformId: () => string = () => "unknown",
  ) {
    this.el = document.createElement("div");
    this.el.className = "capture-bar";

    // Upscale factor selector
    const label = document.createElement("label");
    label.className = "capture-label";
    label.textContent = "Upscale:";

    this.select = document.createElement("select");
    this.select.className = "capture-select";
    for (const v of [1, 2, 4, 8]) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = `${v}\xD7`;
      if (v === 1) opt.selected = true;
      this.select.appendChild(opt);
    }

    // GIF duration selector: Manual / 5s / 10s / 15s. Manual (value "0") = today's
    // behavior (record until Stop or the cap). A preset auto-stops after N seconds.
    const durLabel = document.createElement("label");
    durLabel.className = "capture-label";
    durLabel.textContent = "Duration:";

    this.durationSelect = document.createElement("select");
    this.durationSelect.className = "capture-select";
    for (const [value, text] of [
      ["0", "Manual"],
      ["5", "5s"],
      ["10", "10s"],
      ["15", "15s"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      if (value === "0") opt.selected = true;
      this.durationSelect.appendChild(opt);
    }

    // Screenshot button
    this.shotBtn = document.createElement("button");
    this.shotBtn.type = "button";
    this.shotBtn.className = "capture-btn capture-btn--neutral";
    this.shotBtn.dataset.act = "screenshot";
    this.shotBtn.textContent = "Screenshot";
    this.shotBtn.addEventListener("click", () => void this.takeScreenshot());

    // GIF record toggle
    this.recBtn = document.createElement("button");
    this.recBtn.type = "button";
    this.recBtn.className = "capture-btn capture-btn--rec";
    this.recBtn.textContent = "Record GIF";
    this.recBtn.addEventListener("click", () => void this.toggleRecord());

    // "Light now": fire a single backlight pulse on demand (always available,
    // independent of the automatic capture keepalive).
    this.lightBtn = document.createElement("button");
    this.lightBtn.type = "button";
    this.lightBtn.className = "capture-btn";
    this.lightBtn.dataset.act = "light";
    this.lightBtn.textContent = "Backlight";
    this.lightBtn.addEventListener(
      "click",
      () => void window.studio.backlightPulse(),
    );

    // Status span
    this.status = document.createElement("span");
    this.status.className = "capture-status";

    this.el.appendChild(label);
    this.el.appendChild(this.select);
    this.el.appendChild(durLabel);
    this.el.appendChild(this.durationSelect);
    this.el.appendChild(this.shotBtn);
    this.el.appendChild(this.recBtn);
    this.el.appendChild(this.lightBtn);
    this.el.appendChild(this.status);

    // Keyboard shortcuts: EmulatorView dispatches these (only while the emulator is
    // live, and not while a modal / rebind capture is active) so a bound key can
    // capture without the Capture pane being the open inspector. Event names are
    // mirrored in EmulatorView.handleKeyDown.
    window.addEventListener(
      "pebble-studio:capture-screenshot",
      () => void this.takeScreenshot(),
    );
    window.addEventListener(
      "pebble-studio:capture-record",
      () => void this.toggleRecord(),
    );
  }

  /** Selected duration in seconds, or 0 for Manual. */
  private durationSeconds(): number {
    return parseInt(this.durationSelect.value, 10);
  }

  private factor(): number {
    return parseInt(this.select.value, 10);
  }

  /** True when the emulator screen is actually live (a noVNC <canvas> exists).
   * The host element (#emu-screen) is always present, so its existence alone is
   * not enough — grabbing before a canvas is attached throws "No canvas found". */
  private hasLiveScreen(): boolean {
    const host = this.getHost();
    return !!host && !!host.querySelector("canvas");
  }

  /** Write the status line. `autoClear` transient messages (errors, "not running")
   * wipe themselves after a few seconds so a stale error doesn't linger; steady
   * messages ("Saved: …", "Recording…") persist and cancel any pending clear. */
  private setStatus(text: string, autoClear = false): void {
    if (this.statusClearTimer !== null) {
      clearTimeout(this.statusClearTimer);
      this.statusClearTimer = null;
    }
    this.status.textContent = text;
    if (autoClear) {
      this.statusClearTimer = setTimeout(() => {
        this.statusClearTimer = null;
        this.status.textContent = "";
      }, 4000);
    }
  }

  /** Cancel a pending post-roll backlight release so it can't fire mid-capture and
   * drop the hold that keeps frames bright. Called before each new hold. */
  private cancelBacklightRelease(): void {
    if (this.backlightReleaseTimer !== null) {
      clearTimeout(this.backlightReleaseTimer);
      this.backlightReleaseTimer = null;
    }
  }

  /** K: true when "backlight during capture" is enabled (default ON when unset). */
  private backlightDuringCapture(): boolean {
    return localStorage.getItem(BACKLIGHT_CAPTURE_KEY) !== "false";
  }

  /** Whether to apply the Pebble sunlight color-correction LUT to captures. Default OFF. */
  private sunlightCorrection(): boolean {
    return localStorage.getItem("pebble-studio:sunlight-correction") === "true";
  }

  /**
   * K: hold/release the capture backlight, swallowing any failure so a backlight
   * hiccup never breaks the capture itself. No-op when the pref is off.
   */
  private async setBacklightHold(on: boolean): Promise<void> {
    if (!this.backlightDuringCapture()) return;
    try {
      await window.studio.backlightCaptureHold(on);
    } catch (err) {
      console.warn("[capture] backlightCaptureHold failed (ignored):", err);
    }
  }

  /**
   * Apply mask to frame when on a round platform.
   * For GIF frames also replace masked pixels with the transparent key color
   * so gif.js can index them as transparent.
   */
  private maybeCircularMask(frame: RgbaImage, forGif = false): RgbaImage {
    if (!this.isRound()) return frame;
    const masked = applyCircularMask(frame);
    if (!forGif) return masked;

    // Replace alpha-0 pixels with the GIF transparent key color so gif.js
    // can use them as the transparent index.
    const out = new Uint8Array(masked.data);
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] === 0) {
        out[i] = (GIF_TRANSPARENT_COLOR >> 16) & 0xff; // R
        out[i + 1] = (GIF_TRANSPARENT_COLOR >> 8) & 0xff; // G
        out[i + 2] = GIF_TRANSPARENT_COLOR & 0xff; // B
        out[i + 3] = 255; // make opaque so gif.js sees the color
      }
    }
    return { data: out, width: masked.width, height: masked.height };
  }

  private async takeScreenshot(): Promise<void> {
    const host = this.getHost();

    if (!host) {
      this.setStatus("No emulator screen", true);
      return;
    }

    if (!this.hasLiveScreen()) {
      this.setStatus("Emulator isn't running — launch it first.", true);
      return;
    }

    this.cancelBacklightRelease();

    // Preferred path: use the emulator framebuffer when possible.
    if (
      this.sunlightCorrection() &&
      this.factor() === 1 &&
      !this.framebufferShotUnavailable
    ) {
      try {
        const base = `pebble-shot-${this.getPlatformId()}`;
        const name = await window.studio.nextCaptureName(base, "png");
        const saved = await window.studio.screenshotFramebuffer(name);

        if (saved) {
          this.setStatus(`Saved: ${saved}`);
          return;
        }

        this.framebufferShotUnavailable = true;
      } catch (err) {
        this.framebufferShotUnavailable = true;
        console.warn(
          "[capture] framebuffer screenshot failed; falling back to canvas:",
          err,
        );
      }
    }

    try {
      // Capture the current canvas without injecting Back or motion input.
      const raw = grabUpscaled(host, this.factor());

      if (this.sunlightCorrection()) {
        applySunlightLut(raw.data);
      }

      const frame = this.maybeCircularMask(raw);
      const blob = await rgbaToBlob(frame);
      const bytes = new Uint8Array(await blob.arrayBuffer());

      const base = `pebble-shot-${this.getPlatformId()}`;
      const name = await window.studio.nextCaptureName(base, "png");
      const saved = await window.studio.saveCapture(name, bytes);

      this.setStatus(`Saved: ${saved}`);
    } catch (err) {
      this.setStatus(`Screenshot failed: ${String(err)}`, true);
      console.error("[capture] screenshot error", err);
    }
  }

  private async toggleRecord(): Promise<void> {
    if (this.recording) {
      this.stopRecord();
    } else {
      await this.startRecord();
    }
  }

  private async startRecord(): Promise<void> {
    const host = this.getHost();
    if (!host) {
      this.setStatus("No emulator screen", true);
      return;
    }
    if (!this.hasLiveScreen()) {
      this.setStatus("Emulator isn't running — launch it first.", true);
      return;
    }

    // Mark recording immediately so the button reads "Stop GIF" and a second
    // click can't start a parallel recording during the pre-roll await below.
    this.recording = true;
    this.recBtn.textContent = "Stop GIF";
    this.recBtn.classList.add("capture-btn--recording");
    // Latching happens below (factor/round/correct read once); the encoder's frame
    // size is fixed from the first frame, so lock the Upscale + Duration selects
    // while recording — changing Upscale mid-record would feed gif.js mismatched
    // frame sizes (cropped/corrupt output).
    this.select.disabled = true;
    this.durationSelect.disabled = true;

    // A prior GIF's post-roll release must not fire during this new recording.
    this.cancelBacklightRelease();
    // K: hold the backlight on for the whole recording so frames aren't dim;
    // released (after a post-roll) in stopRecord(). Fire-and-forget.
    void this.setBacklightHold(true);

    // K (v0.0.13.5): let the backlight fully rise BEFORE grabbing any frame, so
    // the GIF is lit from frame one (mirrors the screenshot pre-roll). If the
    // user hits Stop during this beat, stopRecord() flips `recording` off — bail.
    if (this.backlightDuringCapture()) {
      this.setStatus("Lighting…");
      await new Promise((r) => setTimeout(r, GIF_BACKLIGHT_PREROLL_MS));
      if (!this.recording) return; // cancelled during pre-roll
    }

    const correct = this.sunlightCorrection();
    // Latch the upscale factor once so every frame is grabbed at the SAME size the
    // gif encoder was created with (the selects are disabled above, but a const is
    // the unambiguous source of truth to match `correct`/`round`/`platformId`).
    const factor = this.factor();

    // Grab a first frame to determine dimensions
    let firstFrame: RgbaImage;
    try {
      firstFrame = grabUpscaled(host, factor);
      if (correct) applySunlightLut(firstFrame.data);
    } catch (err) {
      this.setStatus(`Grab failed: ${String(err)}`, true);
      this.recording = false;
      this.recBtn.textContent = "Record GIF";
      this.recBtn.classList.remove("capture-btn--recording");
      this.select.disabled = false;
      this.durationSelect.disabled = false;
      void this.setBacklightHold(false);
      return;
    }

    // A preset (5/10/15s) caps the budget at exactly that many seconds so the
    // existing isFull() path auto-stops. Manual uses the full hard cap.
    const preset = this.durationSeconds();
    const maxSeconds = preset > 0 ? preset : GIF_MAX_SECONDS;
    const budget = new FrameBudget({ fps: 15, maxSeconds });
    const platformId = this.getPlatformId();
    const round = this.isRound();

    const gifOptions: ConstructorParameters<typeof GIF>[0] = {
      workers: 2,
      quality: 10,
      width: firstFrame.width,
      height: firstFrame.height,
      workerScript: "./gif.worker.js",
    };
    if (round) {
      gifOptions.transparent = GIF_TRANSPARENT_COLOR;
      gifOptions.background = "#ff00ff";
    }

    this.gif = new GIF(gifOptions);

    const gifRef = this.gif;

    gifRef.on("finished", (blob: Blob) => {
      void blob
        .arrayBuffer()
        .then(async (ab) => {
          const bytes = new Uint8Array(ab);
          // G: pebble-rec-<codename>-<n>.gif (n = next free integer from main).
          const base = `pebble-rec-${platformId}`;
          const name = await window.studio.nextCaptureName(base, "gif");
          const saved = await window.studio.saveCapture(name, bytes);
          this.setStatus(`GIF saved: ${saved}`);
        })
        .catch((err: unknown) => {
          this.setStatus(`GIF save failed: ${String(err)}`, true);
          console.error("[capture] gif save error", err);
        });
    });

    // Frames are grabbed on an interval, but under load the interval slips, so
    // stamp each frame with its ACTUAL elapsed wall-clock time (not a fixed
    // frameDelayMs) — otherwise the GIF plays back faster than real time.
    let lastFrameAt = performance.now();
    // Secondary safety bound: even if frame accounting somehow stalls, never run
    // past the budgeted duration plus a small margin.
    const startedAt = Date.now();
    const hardStopMs = (maxSeconds + 2) * 1000;
    // Once the live screen vanishes mid-recording (e.g. Force-close), every grab
    // throws — tryAdd() never runs, isFull() never trips, and the interval would
    // loop forever spamming the console. Bail after a few consecutive failures.
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    // Add the first frame immediately
    if (budget.tryAdd()) {
      const maskedFirst = this.maybeCircularMask(firstFrame, true);
      const canvas = this.imageToCanvas(maskedFirst);
      gifRef.addFrame(canvas, { delay: budget.frameDelayMs(), copy: true });
    }

    this.recTimer = setInterval(() => {
      if (
        !this.recording ||
        budget.isFull() ||
        Date.now() - startedAt >= hardStopMs
      ) {
        this.stopRecord();
        return;
      }
      try {
        const raw = grabUpscaled(host, factor);
        consecutiveFailures = 0;
        if (correct) applySunlightLut(raw.data);
        if (budget.tryAdd()) {
          const frame = this.maybeCircularMask(raw, true);
          const canvas = this.imageToCanvas(frame);
          const now = performance.now();
          const delay = Math.max(10, Math.round(now - lastFrameAt));
          lastFrameAt = now;
          gifRef.addFrame(canvas, { delay, copy: true });
          this.setStatus(`Recording… ${budget.remaining()} frames left`);
        }
      } catch (err) {
        console.error("[capture] gif frame error", err);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.setStatus(
            "Recording stopped — emulator screen unavailable.",
            true,
          );
          this.stopRecord();
          return;
        }
      }
      if (budget.isFull()) {
        this.stopRecord();
      }
    }, budget.frameDelayMs());
  }

  private imageToCanvas(image: RgbaImage): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    const clampedData = new Uint8ClampedArray(image.data.length);
    clampedData.set(image.data);
    const imageData = new ImageData(clampedData, image.width, image.height);
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  private stopRecord(): void {
    if (this.recTimer !== null) {
      clearInterval(this.recTimer);
      this.recTimer = null;
    }
    this.recording = false;
    this.recBtn.textContent = "Record GIF";
    this.recBtn.classList.remove("capture-btn--recording");
    // Re-enable the controls locked for the duration of the recording.
    this.select.disabled = false;
    this.durationSelect.disabled = false;
    // K (v0.0.13.5): keep the backlight held for a short post-roll after Stop,
    // then release — so the final frames (grabbed just before this) stay lit and
    // the release never races a last in-flight grab. Fire-and-forget. The id is
    // tracked (and cancelled by the next capture) so this stale release can't fire
    // mid-way through a rapid Record→Stop→Record / screenshot and dim it.
    this.cancelBacklightRelease();
    this.backlightReleaseTimer = setTimeout(() => {
      this.backlightReleaseTimer = null;
      void this.setBacklightHold(false);
    }, GIF_BACKLIGHT_POSTROLL_MS);
    if (this.gif) {
      this.gif.render();
      this.gif = null;
      this.setStatus("Encoding GIF…");
    }
  }
}
