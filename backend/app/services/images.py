from io import BytesIO
import logging
import re
from threading import BoundedSemaphore
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import Settings
from app.services.errors import AnalysisError

logger = logging.getLogger(__name__)

# Pillow reports iPhone camera JPEGs as MPO (primary image plus extra frames).
FORMATS = {"JPEG": "image/jpeg", "MPO": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
ALLOWED_TYPES = frozenset(FORMATS.values())
# One decode/re-encode at a time bounds peak memory (about 340 MiB for a 20 MP WebP).
_DECODE_SLOTS = BoundedSemaphore(1)
_DECODE_WAIT_SECONDS = 5.0
_BUSY_DETAIL = "Server is busy processing another image. Please try again in a few seconds."
# Display copies stored in the logbook bucket (file_size_limit 3 MiB in supabase/migrations/0001_logbook.sql).
DISPLAY_MAX_EDGE = 2048
DISPLAY_MAX_BYTES = 3 * 1024 * 1024
_DISPLAY_QUALITIES = (85, 75, 65)
THUMB_MAX_EDGE = 256
THUMB_QUALITY = 80


def _reject(
    status_code: int, detail: str, rule: str, content_type: str | None, detected_format: str | None = None
) -> AnalysisError:
    """Log a rejection without image content; client-supplied values are allowlisted."""
    declared = content_type if content_type in ALLOWED_TYPES else ("other" if content_type else "none")
    detected = re.sub(r"[^A-Z0-9]", "", str(detected_format or "").upper())[:16] or "none"
    logger.warning(
        "Image rejected rule=%s status=%s declared_type=%s detected_format=%s",
        rule, status_code, declared, detected,
    )
    return AnalysisError(status_code, detail)


def _reencode(data: bytes, detected_format: str) -> bytes:
    """Decode the first frame, apply EXIF orientation, and re-encode without metadata."""
    with Image.open(BytesIO(data)) as source:
        source.load()  # For MPO this decodes only the primary (first) frame.
        ImageOps.exif_transpose(source, in_place=True)
        image, source_mode = source, source.mode
        icc_profile = source.info.get("icc_profile")
        transparency = source.info.get("transparency")
        params: dict = {}
        if detected_format in ("JPEG", "MPO"):
            output_format = "JPEG"
            params["quality"] = 95  # Deliberate second-generation lossy encode.
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
        elif detected_format == "PNG":
            output_format = "PNG"  # Lossless; mode, alpha, palette and 16-bit grayscale are kept.
            if transparency is not None:
                params["transparency"] = transparency
        else:
            output_format = "WEBP"
            params["quality"] = 95  # Lossy: most source WebPs are already lossy.
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if image.has_transparency_data else "RGB")
        # An ICC profile describes the source mode's colour space; drop it after conversion.
        if icc_profile and image.mode == source_mode:
            params["icc_profile"] = icc_profile
        image.info = {}  # Drop EXIF/GPS, XMP, comments and PNG text chunks.
        output = BytesIO()
        image.save(output, format=output_format, **params)
        return output.getvalue()


def prepare_image(data: bytes, content_type: str | None, settings: Settings) -> tuple[bytes, str]:
    """Validate an upload and return metadata-free bytes with their MIME type."""
    if not data:
        raise _reject(400, "Image is empty.", "empty", content_type)
    if len(data) > settings.max_image_bytes:
        raise _reject(413, "Image exceeds the upload size limit.", "upload_too_large", content_type)
    if content_type not in ALLOWED_TYPES:
        raise _reject(415, "Upload a JPEG, PNG, or WebP image.", "declared_type", content_type)
    pixel_limit = (
        f"Image resolution exceeds the limit of {settings.max_image_pixels:,} pixels. "
        "Choose a smaller image or lower the camera resolution."
    )
    detected_format = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                detected_format = image.format
                if FORMATS.get(detected_format) != content_type:
                    raise _reject(415, "Image content does not match its declared type.",
                                  "type_mismatch", content_type, detected_format)
                if image.width * image.height > settings.max_image_pixels:
                    raise _reject(413, pixel_limit, "pixel_limit", content_type, detected_format)
                if getattr(image, "n_frames", 1) != 1 and detected_format != "MPO":
                    raise _reject(415, "Upload a single-frame image.", "multi_frame", content_type, detected_format)
                image.verify()
            if not _DECODE_SLOTS.acquire(timeout=_DECODE_WAIT_SECONDS):
                raise _reject(503, _BUSY_DETAIL, "busy", content_type, detected_format)
            try:
                encoded = _reencode(data, detected_format)
            finally:
                _DECODE_SLOTS.release()
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise _reject(413, pixel_limit, "pixel_limit", content_type, detected_format) from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise _reject(400, "Image is corrupt or cannot be decoded.", "decode_error",
                      content_type, detected_format) from exc
    if len(encoded) > settings.max_encoded_image_bytes:
        raise _reject(413, "The processed image is too large to analyze. Please choose a smaller image.",
                      "output_too_large", content_type, detected_format)
    return encoded, FORMATS[detected_format]


def _to_rgb(image: Image.Image) -> Image.Image:
    """8-bit RGB; transparency is composited onto white, 16-bit grayscale scaled to 8 bits."""
    if image.mode in ("I;16", "I;16B", "I;16L", "I"):
        image = image.convert("I").point(lambda value: value * (1 / 256)).convert("L")
    if image.has_transparency_data:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return background
    return image if image.mode == "RGB" else image.convert("RGB")


def _encode_jpeg(image: Image.Image, quality: int, icc_profile: bytes | None) -> bytes:
    params: dict = {"quality": quality, "optimize": True}
    if icc_profile:
        params["icc_profile"] = icc_profile
    output = BytesIO()
    image.save(output, format="JPEG", **params)
    return output.getvalue()


def _display_copies(cleaned: bytes) -> tuple[bytes, bytes] | None:
    with Image.open(BytesIO(cleaned)) as source:
        source.load()
        # Same rule as _reencode: the ICC profile only describes the unconverted mode.
        icc_profile = source.info.get("icc_profile") if source.mode == "RGB" else None
        display = _to_rgb(source)
        display.info = {}  # prepare_image output is already metadata-free; keep it that way.
        display.thumbnail((DISPLAY_MAX_EDGE, DISPLAY_MAX_EDGE), Image.Resampling.LANCZOS)
        for quality in _DISPLAY_QUALITIES:
            display_bytes = _encode_jpeg(display, quality, icc_profile)
            if len(display_bytes) <= DISPLAY_MAX_BYTES:
                break
        else:
            return None
        thumb = display.copy()
        thumb.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.Resampling.LANCZOS)
        return display_bytes, _encode_jpeg(thumb, THUMB_QUALITY, icc_profile)


def make_display_copies(cleaned: bytes, mime: str) -> tuple[bytes, bytes]:
    """JPEG display copy (long edge <= 2048 px) and 256 px thumbnail of prepare_image output.

    Both are metadata-free. Gemini still receives the full cleaned bytes.
    """
    if not _DECODE_SLOTS.acquire(timeout=_DECODE_WAIT_SECONDS):
        raise _reject(503, _BUSY_DETAIL, "busy", mime)
    try:
        copies = _display_copies(cleaned)
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise _reject(400, "Image is corrupt or cannot be decoded.", "display_decode_error", mime) from exc
    finally:
        _DECODE_SLOTS.release()
    if copies is None:
        raise _reject(413, "The processed image is too large to store. Please choose a smaller image.",
                      "display_too_large", mime)
    return copies
