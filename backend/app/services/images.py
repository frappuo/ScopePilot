from io import BytesIO
import warnings

from PIL import Image, UnidentifiedImageError

from app.config import Settings
from app.services.errors import AnalysisError

FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


def validate_image(data: bytes, content_type: str | None, settings: Settings) -> str:
    if not data:
        raise AnalysisError(400, "Image is empty.")
    if len(data) > settings.max_image_bytes:
        raise AnalysisError(413, "Image exceeds the upload size limit.")
    if content_type not in FORMATS.values():
        raise AnalysisError(415, "Upload a JPEG, PNG, or WebP image.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                detected_type = FORMATS.get(image.format)
                if detected_type is None or detected_type != content_type:
                    raise AnalysisError(415, "Image content does not match its declared type.")
                if image.width * image.height > settings.max_image_pixels:
                    raise AnalysisError(413, "Image exceeds the pixel limit.")
                if getattr(image, "n_frames", 1) != 1:
                    raise AnalysisError(415, "Upload a single-frame image.")
                image.verify()
            # Verify container integrity and actual pixel decoding.
            with Image.open(BytesIO(data)) as image:
                image.load()
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise AnalysisError(413, "Image exceeds the pixel limit.") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise AnalysisError(400, "Image is corrupt or cannot be decoded.") from exc
    return detected_type
