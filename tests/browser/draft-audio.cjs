/* Exercise the real AudioWorklet with a generated tone, not a physical mic. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.goto(`${url}/health`);
    const audio = await page.evaluate(async () => {
      const { microphone } = await import("/static/draft-recording.js");
      const tone = new AudioContext({ sampleRate: 16000 });
      const oscillator = tone.createOscillator(); const destination = tone.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); await tone.resume();
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => destination.stream });
      const chunks = [], failures = [];
      const input = await microphone(chunk => chunks.push(chunk), reason => failures.push(reason));
      await new Promise(resolve => setTimeout(resolve, 550));
      input.boundary();
      await new Promise(resolve => setTimeout(resolve, 180));
      await input.close(); oscillator.stop(); await tone.close();
      return { failures, chunks: await Promise.all(chunks.map(async chunk => {
        const bytes = await chunk.audio.arrayBuffer(); const view = new DataView(bytes);
        let nonzero = false;
        for (let offset = 44; offset < bytes.byteLength; offset += 2) if (view.getInt16(offset, true)) nonzero = true;
        return { start: chunk.start, end: chunk.end, duration: chunk.duration,
          samples: view.getUint32(40, true) / 2, rate: view.getUint32(24, true), nonzero };
      })) };
    });
    assert.deepEqual(audio.failures, []);
    assert.equal(audio.chunks.length, 2, "manual boundary plus worklet tail flush");
    assert(audio.chunks.every(chunk => chunk.nonzero && chunk.rate === 16000));
    assert.equal(audio.chunks[0].end, audio.chunks[1].start, "real worklet boundary has no gaps or overlap");
    assert(audio.chunks.every(chunk => chunk.duration === chunk.samples / chunk.rate));
    console.log("PASS: real AudioWorklet tone capture, independent WAVs, contiguous manual boundary and final sub-block flush.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
