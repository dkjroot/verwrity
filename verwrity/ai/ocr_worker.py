"""Isolated OCR worker: progress heartbeats, one active request, real cancellation."""
from dataclasses import asdict, replace
from multiprocessing import get_context
from queue import Empty, Full
from threading import Lock
from time import monotonic
import atexit
import logging

from verwrity.ai.ocr import OCRRegistry, OCRError


def worker_main(incoming, outgoing):
    registry = OCRRegistry()
    while True:
        job = incoming.get()
        if job is None:
            return
        request, settings = job
        def progress(stage, tokens=0):
            try: outgoing.put_nowait({"stage": stage, "tokens": tokens})
            except Full: pass
        try:
            result = registry.get(settings["provider"]).recognize(replace(request, progress=progress), settings)
            outgoing.put({"result": asdict(result)})
        except Exception as error:
            outgoing.put({"error": str(error) if isinstance(error, OCRError) else "OCR worker failed. Source images are retained."})


class OCRWorker:
    def __init__(self, target=worker_main):
        self.target, self.process, self.incoming, self.outgoing = target, None, None, None
        self.provider = None
        self.lock = Lock()
        atexit.register(self.stop)

    def stop(self):
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
                self.process.join(timeout=2)
            self.process.close()
            self.process = None
        for queue in (self.incoming, self.outgoing):
            if queue:
                queue.cancel_join_thread(); queue.close()
        self.incoming = self.outgoing = None
        self.provider = None

    def run(self, request, settings):
        if not self.lock.acquire(blocking=False):
            raise OCRError("Another OCR page/test is already running. Cancel it or wait for completion before starting another.")
        completed, started, logged = False, monotonic(), 0
        log = logging.getLogger("verwrity.ai.ocr")
        stage, tokens = "Starting isolated OCR worker", 0
        try:
            if self.process is None or not self.process.is_alive() or self.provider != settings["provider"]:
                # Switching to hosted OCR releases any resident local GPU model.
                self.stop()
                ctx = get_context("spawn")
                self.incoming, self.outgoing = ctx.Queue(1), ctx.Queue(32)
                self.process = ctx.Process(target=self.target, args=(self.incoming, self.outgoing), daemon=True)
                self.process.start()
                self.provider = settings["provider"]
            self.incoming.put((request, settings))
            log.info("OCR started (%s, %s)", settings["provider"], settings["device"])
            yield {"stage": stage, "elapsed": 0, "tokens": 0}
            while True:
                try:
                    event = self.outgoing.get(timeout=1)
                except Empty:
                    if not self.process.is_alive():
                        raise OCRError("OCR worker exited unexpectedly (possibly insufficient memory). Source images are retained; inspect system memory and retry explicitly.")
                    event = {"stage": stage, "tokens": tokens}
                elapsed = round(monotonic() - started, 1)
                if "result" in event or "error" in event:
                    completed = True
                    log.info("OCR %s after %.1fs", "completed" if "result" in event else "failed", elapsed)
                    yield {**event, "elapsed": elapsed}
                    return
                changed = stage != event["stage"]
                stage, tokens = event["stage"], event.get("tokens", 0)
                if changed or elapsed - logged >= 15:
                    log.info("OCR: %s (%.1fs elapsed, %s generated tokens)", stage, elapsed, tokens)
                    logged = elapsed
                yield {"stage": stage, "tokens": tokens, "elapsed": elapsed}
        finally:
            if not completed:
                log.info("OCR cancelled/stopped after %.1fs; releasing worker", monotonic() - started)
                self.stop()
            self.lock.release()
