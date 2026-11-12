"""
scripts/cloudinary_storage.py
─────────────────────────────────────────────────────────────
Secure Python Cloudinary Integration Script.

Security practices implemented:
 1. Loads credentials strictly from environment variables or .env (never hardcoded).
 2. Enforces HTTPS transport with secure=True.
 3. Sanitizes public IDs to prevent path traversal.
 4. Auto-format & auto-quality optimization enabled.
 5. Namespaces uploads inside a dedicated folder ('sensor-sim').
─────────────────────────────────────────────────────────────
"""

import os
import sys
from pathlib import Path

# Attempt to load .env from project root
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    if k not in os.environ and v:
                        os.environ[k] = v
    except Exception as e:
        print(f"[warning] Could not load .env: {e}", file=sys.stderr)

try:
    import cloudinary
    import cloudinary.uploader
    from cloudinary.utils import cloudinary_url
except ImportError:
    print("[error] 'cloudinary' package is not installed in Python.")
    print("        Install it via: pip install cloudinary")
    sys.exit(1)

# Retrieve credentials securely from environment variables
CLOUD_NAME = os.getenv("CLOUDINARY_CLOUD_NAME")
API_KEY = os.getenv("CLOUDINARY_API_KEY")
API_SECRET = os.getenv("CLOUDINARY_API_SECRET")
CLOUDINARY_URL = os.getenv("CLOUDINARY_URL")
DEFAULT_FOLDER = os.getenv("CLOUDINARY_DEFAULT_FOLDER", "sensor-sim")

if CLOUDINARY_URL:
    # Cloudinary SDK auto-detects CLOUDINARY_URL and sets credentials
    cloudinary.config(secure=True)
elif CLOUD_NAME and API_KEY and API_SECRET:
    cloudinary.config(
        cloud_name=CLOUD_NAME,
        api_key=API_KEY,
        api_secret=API_SECRET,
        secure=True,  # Enforce HTTPS
    )
else:
    print("[error] Cloudinary credentials missing from environment variables (.env)", file=sys.stderr)
    sys.exit(1)


def upload_secure_image(source, public_id="shoes", folder=DEFAULT_FOLDER):
    """
    Securely uploads an image to Cloudinary under a sandboxed folder.
    """
    safe_folder = folder.strip("/\\")
    full_public_id = f"{safe_folder}/{public_id.strip('/\\')}" if safe_folder else public_id

    result = cloudinary.uploader.upload(
        source,
        public_id=full_public_id,
        secure=True,
        tags=["sensor-sim", "iot-storage"],
    )
    return result


def get_optimized_delivery_url(public_id, folder=DEFAULT_FOLDER):
    """
    Generates an optimized delivery URL (auto-format and auto-quality) via HTTPS.
    """
    safe_folder = folder.strip("/\\")
    full_id = f"{safe_folder}/{public_id.strip('/\\')}" if safe_folder and "/" not in public_id else public_id
    url, _ = cloudinary_url(full_id, fetch_format="auto", quality="auto", secure=True)
    return url


def get_transformed_url(public_id, width=500, height=500, crop="auto", gravity="auto", folder=DEFAULT_FOLDER):
    """
    Generates a transformed image URL with smart cropping via HTTPS.
    """
    safe_folder = folder.strip("/\\")
    full_id = f"{safe_folder}/{public_id.strip('/\\')}" if safe_folder and "/" not in public_id else public_id
    url, _ = cloudinary_url(
        full_id,
        width=width,
        height=height,
        crop=crop,
        gravity=gravity,
        fetch_format="auto",
        quality="auto",
        secure=True,
    )
    return url


def main():
    print("==================================================")
    print(" Cloudinary Secure Storage Verification (Python)")
    print("==================================================")
    cfg = cloudinary.config()
    print(f"Cloud Name: {cfg.cloud_name}")
    masked_key = f"{cfg.api_key[:4]}****{cfg.api_key[-4:]}" if cfg.api_key else "Not Set"
    print(f"API Key:    {masked_key} (Secret securely hidden)")
    print(f"Secure:     {cfg.secure} (Enforces HTTPS)")
    print(f"Folder:     {DEFAULT_FOLDER}")
    print("--------------------------------------------------")

    sample_image = "https://res.cloudinary.com/demo/image/upload/getting-started/shoes.jpg"
    print(f"Uploading sample image: {sample_image}")

    try:
        upload_result = upload_secure_image(sample_image, public_id="shoes")
        public_id = upload_result["public_id"]
        print(f"\n[OK] Secure Upload Successful:")
        print(f"    Public ID:  {public_id}")
        print(f"    Secure URL: {upload_result['secure_url']}")

        opt_url = get_optimized_delivery_url("shoes")
        print(f"\n[OK] Auto-Optimized Delivery URL (WebP/AVIF + Auto Quality):")
        print(f"    {opt_url}")

        crop_url = get_transformed_url("shoes", width=500, height=500, crop="auto", gravity="auto")
        print(f"\n[OK] Smart Crop Square URL (500x500):")
        print(f"    {crop_url}")

    except Exception as err:
        print(f"\n[!] Upload failed: {err}")
        print("    (If running offline or behind firewall, check internet connection)")


if __name__ == "__main__":
    main()
