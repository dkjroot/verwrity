"""Bounded local image/video decoding and conservative still selection."""
from io import BytesIO
from dataclasses import dataclass
from uuid import uuid4
import base64
import math
from functools import lru_cache

from verwrity.ai.ocr import OCRError

MAX_UPLOAD = 1024 * 1024 * 1024
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_PIXELS = 48_000_000
MAX_PAGES = 500
SAMPLE_SECONDS = .25


def imaging():
    try:
        from PIL import Image, ImageOps, ImageChops, ImageStat, ImageFilter
        return Image, ImageOps, ImageChops, ImageStat, ImageFilter
    except ImportError:
        raise OCRError("Image import needs Pillow. Install the ocr-import extra, then restart Verwrity.") from None


def read_image(data):
    Image, ImageOps, *_ = imaging()
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise OCRError("Choose an image of at most 24 MiB.")
    try:
        with Image.open(BytesIO(data)) as source:
            if source.width * source.height > MAX_PIXELS:
                raise OCRError("Image exceeds 48 million pixels. Resize it before importing.")
            if source.format not in {"JPEG", "PNG", "WEBP"}:
                raise OCRError("Use JPEG, PNG or WebP images. Convert HEIC on your phone first.")
            oriented = ImageOps.exif_transpose(source).convert("RGBA")
            return Image.alpha_composite(Image.new("RGBA", oriented.size, "white"), oriented).convert("RGB")
    except OCRError:
        raise
    except Exception:
        raise OCRError("This image could not be decoded safely. Use a readable JPEG or PNG.") from None


def encoded(image):
    output = BytesIO()
    image.save(output, format="JPEG", quality=94)
    return base64.b64encode(output.getvalue()).decode("ascii")


def fingerprint(image):
    """Text-sensitive edge grid; blank paper must not dominate similarity."""
    _, ImageOps, _, _, ImageFilter = imaging()
    gray = image.convert("L")
    w, h = gray.size
    gray = gray.crop((int(w * .04), int(h * .04), int(w * .96), int(h * .96))).resize((256, 256))
    edges = gray.filter(ImageFilter.FIND_EDGES).crop((2, 2, 254, 254)).resize((64, 64))
    return base64.b64encode(ImageOps.autocontrast(edges).tobytes()).decode("ascii")


@lru_cache(maxsize=1024)
def decoded_fingerprint(value):
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise OCRError("Invalid similarity fingerprint.") from None
    if len(data) != 4096:
        raise OCRError("Reimport these older captures to compare their image fingerprints.")
    Image, *_ = imaging()
    return Image.frombytes("L", (64, 64), data)


def similarity(a, b):
    _, _, ImageChops, ImageStat, _ = imaging()
    a, b = decoded_fingerprint(a), decoded_fingerprint(b)
    # Native Pillow operations keep comparisons cheap. Small alignment offsets
    # tolerate a page moving slightly without letting white paper dominate.
    region = (2, 2, 62, 62)
    source, best = a.crop(region), 0
    for dx, dy in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
        target = ImageChops.offset(b, dx, dy).crop(region)
        total = ImageStat.Stat(ImageChops.lighter(source, target)).sum[0]
        score = 1 if not total else max(0, 1 - ImageStat.Stat(ImageChops.difference(source, target)).sum[0] / total)
        best = max(best, score)
        if best >= .9999:
            break
    return round(best, 4)


def transform(image, values):
    if not isinstance(values, dict):
        raise OCRError("Invalid page adjustment.")
    rotation = values.get("rotation", 0)
    if type(rotation) not in (int, float) or not math.isfinite(rotation) or abs(rotation) > 180:
        raise OCRError("Rotation must be between -180 and 180 degrees.")
    crop = values.get("crop", [0, 0, 1, 1])
    if (not isinstance(crop, list) or len(crop) != 4 or
            any(type(x) not in (int, float) or not math.isfinite(x) for x in crop) or
            not (0 <= crop[0] < crop[2] <= 1 and 0 <= crop[1] < crop[3] <= 1)):
        raise OCRError("Use a crop inside the image with positive width and height.")
    width, height = image.size
    image = image.crop((int(width * crop[0]), int(height * crop[1]), int(width * crop[2]), int(height * crop[3])))
    if min(image.size) < 16:
        raise OCRError("The selected crop is too small to read.")
    if rotation:
        image = image.rotate(rotation, expand=True, fillcolor="white")
    image.thumbnail((3200, 3200))
    if values.get("profile") is not None:
        from verwrity.ai.ocr_preprocess import ImageProfile
        image = ImageProfile.parse(values["profile"]).apply(image)
    return image


@dataclass
class Candidate:
    image: object
    time: float
    score: float
    signature: object


def sharpness(image):
    _, _, _, ImageStat, ImageFilter = imaging()
    gray = image.convert("L")
    gray.thumbnail((512, 512))
    w, h = gray.size
    # Exclude the paper/surface boundary; compare text detail at a shared scale.
    edges = gray.filter(ImageFilter.FIND_EDGES).crop((int(w * .08), int(h * .08), int(w * .92), int(h * .92)))
    return round(ImageStat.Stat(edges).var[0], 2)


def candidate(image, timestamp):
    image.thumbnail((3200, 3200))
    gray = image.convert("L").resize((256, 256))
    score = sharpness(image)
    return Candidate(image, timestamp, score, gray)


def difference(a, b):
    _, _, ImageChops, ImageStat, _ = imaging()
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]


def packet(candidates, uncertain=False):
    best = sorted(candidates, key=lambda x: x.score, reverse=True)[:3]
    return {"id": str(uuid4()), "timestamp": best[0].time,
        "start": min(c.time for c in candidates), "end": max(c.time for c in candidates),
        "fingerprint": fingerprint(best[0].image), "fingerprint_version": 2,
        "uncertain": uncertain, "variants": [{"image": encoded(c.image), "timestamp": c.time,
        "sharpness": round(c.score, 2)} for c in best]}


def select_frames(frames):
    """Retain stable runs and one uncertain capture per moving interval.

    No text recognition, page numbering or duplicate deletion is involved.
    Only a few full-resolution frames are retained at any time.
    """
    group, moving, anchor, previous, count, start = [], [], None, None, 0, 0
    def retain(items, item):
        items.append(item)
        items.sort(key=lambda x: x.score, reverse=True)
        del items[3:]
    for item in frames:
        if isinstance(item, dict):
            yield item
            continue
        steady = previous is not None and difference(previous.signature, item.signature) < 2.2
        same = anchor is not None and difference(anchor, item.signature) < 2.2
        if group and (not steady or not same):
            if count >= 3:
                result = packet(group)
                result.update(start=start, end=previous.time)
                yield result
            else:
                for old in group:
                    retain(moving, old)
            group, count, anchor = [], 0, None
        if steady:
            if not group:
                moving = [frame for frame in moving if frame is not previous]
                if moving:
                    yield packet(moving, True)
                    moving = []
                anchor, start = previous.signature, previous.time
                retain(group, previous)
                count = 1
            retain(group, item)
            count += 1
        else:
            retain(moving, item)
        previous = item
    if group:
        if count >= 3:
            result = packet(group)
            result.update(start=start, end=previous.time)
            yield result
        else:
            for old in group:
                retain(moving, old)
    if moving:
        yield packet(moving, True)


def capture_video(source, rotation=0):
    try:
        import av
    except ImportError:
        raise OCRError("Video import needs PyAV. Install the ocr-import extra and restart Verwrity.") from None
    try:
        with av.open(source, mode="r", options={"protocol_whitelist": "pipe"}) as container:
            stream = next((s for s in container.streams if s.type == "video"), None)
            if stream is None:
                raise OCRError("The file has no video stream.")
            if stream.width * stream.height > MAX_PIXELS:
                raise OCRError("Video frames exceed 48 million pixels.")
            def frames():
                next_time, progress = 0, 0
                for index, frame in enumerate(container.decode(stream)):
                    if frame.width * frame.height > MAX_PIXELS:
                        raise OCRError("A decoded video frame exceeds 48 million pixels.")
                    timestamp = float(frame.time) if frame.time is not None else index / float(stream.average_rate or 30)
                    if timestamp < next_time:
                        continue
                    next_time = timestamp + SAMPLE_SECONDS
                    image = frame.to_image()
                    # PyAV exposes display-matrix rotation for phone videos.
                    rotation = getattr(frame, "rotation", 0)
                    if rotation:
                        image = image.rotate(-rotation, expand=True)
                    if extra_rotation:
                        image = image.rotate(-extra_rotation, expand=True)
                    yield candidate(image, timestamp)
                    if timestamp >= progress:
                        progress = timestamp + 2
                        yield {"progress": timestamp}
            extra_rotation = rotation
            emitted, seen = 0, []
            for result in select_frames(frames()):
                if "id" in result:
                    result["frame_step"] = 1 / float(stream.average_rate or 30)
                    emitted += 1
                    signature = result["fingerprint"]
                    similar = next((identity for identity, previous in seen
                        if similarity(signature, previous) >= .95), None)
                    if similar:
                        result["similar_to"] = similar
                    seen.append((result["id"], signature))
                if emitted > MAX_PAGES:
                    raise OCRError("Capture reached 500 candidates. Completed captures are retained; split the remaining video.")
                yield result
            if not emitted:
                raise OCRError("No video frames could be decoded.")
    except (OCRError, GeneratorExit):
        raise
    except Exception:
        raise OCRError("Video decoding failed. Completed captures are retained; try MP4/MOV with H.264 video.") from None
