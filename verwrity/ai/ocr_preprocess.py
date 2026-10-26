"""Explicit, reversible OCR image profiles using the existing Pillow dependency."""
from dataclasses import dataclass
import math

from verwrity.ai.ocr import OCRError


@dataclass(frozen=True)
class ImageProfile:
    longest_edge: int = 1288
    brightness: float = 1
    contrast: float = 1
    sharpness: float = 1
    mode: str = "color"
    threshold: int = 160
    autocontrast: bool = False

    @classmethod
    def parse(cls, value):
        if not isinstance(value, dict) or value.keys() - cls.__dataclass_fields__.keys():
            raise OCRError("Invalid OCR image profile.")
        profile = cls(**value)
        for name, low, high in (("longest_edge", 512, 3200), ("brightness", .25, 3),
                ("contrast", .25, 4), ("sharpness", 0, 5), ("threshold", 1, 254)):
            number = getattr(profile, name)
            if type(number) not in (int, float) or not math.isfinite(number) or not low <= number <= high:
                raise OCRError(f"Invalid profile {name}: use {low}–{high}.")
        if type(profile.longest_edge) is not int or type(profile.threshold) is not int:
            raise OCRError("Profile dimensions and threshold must be whole numbers.")
        if profile.mode not in ("color", "gray", "bw") or type(profile.autocontrast) is not bool:
            raise OCRError("Choose color, greyscale or black-and-white for the image profile.")
        return profile

    def apply(self, source):
        from PIL import Image, ImageEnhance, ImageOps
        image = source.copy()
        image.thumbnail((self.longest_edge, self.longest_edge), Image.Resampling.LANCZOS)
        if self.mode != "color":
            image = image.convert("L")
        if self.autocontrast:
            image = ImageOps.autocontrast(image)
        image = ImageEnhance.Brightness(image).enhance(self.brightness)
        image = ImageEnhance.Contrast(image).enhance(self.contrast)
        image = ImageEnhance.Sharpness(image).enhance(self.sharpness)
        if self.mode == "bw":
            image = image.convert("L").point(lambda pixel: 255 if pixel >= self.threshold else 0)
        return image.convert("RGB")
