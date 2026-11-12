/**
 * src/storage/cloudinary.js
 * ─────────────────────────────────────────────────────────────
 * Enterprise Cloudinary Storage Client & Security Wrapper.
 *
 * Security Features:
 *  1. Secrets are loaded strictly from environment variables (.env).
 *  2. secure: true is enforced across all API calls and URL generation (HTTPS).
 *  3. Secrets are never exposed to client-side code, logs, or status endpoints.
 *  4. Client direct-upload signatures (HMAC-SHA) are generated server-side.
 *  5. File type whitelisting and payload size limits prevent malicious uploads.
 *  6. Public IDs and paths are sanitized against directory traversal attacks.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const path = require('path');
const cloudinary = require('cloudinary').v2;

// ── Configuration ─────────────────────────────────────────────────────────────

const cloudName = process.env.CLOUDINARY_CLOUD_NAME || '';
const apiKey    = process.env.CLOUDINARY_API_KEY || '';
const apiSecret = process.env.CLOUDINARY_API_SECRET || '';

// Configure SDK with secure HTTPS transport enforced
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({
    secure: true,
  });
} else if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key:    apiKey,
    api_secret: apiSecret,
    secure:     true,
  });
}

// ── Security Constraints & Whitelists ─────────────────────────────────────────

const DEFAULT_FOLDER = process.env.CLOUDINARY_DEFAULT_FOLDER || 'sensor-sim';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB limit

const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  // Documents / Telemetry Proofs
  'application/pdf',
  'text/csv',
  'application/json',
  'text/plain',
]);

const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'svg',
  'pdf', 'csv', 'json', 'txt'
]);

/**
 * Checks whether Cloudinary credentials have been provided.
 * @returns {boolean}
 */
function isConfigured() {
  const cfg = cloudinary.config();
  return Boolean(cfg.cloud_name && cfg.api_key && cfg.api_secret);
}

/**
 * Returns safe metadata about the Cloudinary storage setup.
 * CRITICAL: api_secret is NEVER returned or logged.
 */
function getStatus() {
  const cfg = cloudinary.config();
  const configured = isConfigured();
  const key = cfg.api_key || apiKey || '';

  return {
    configured,
    provider: 'Cloudinary',
    cloudName: cfg.cloud_name || cloudName || null,
    apiKeyMasked: key ? `${key.slice(0, 4)}••••${key.slice(-4)}` : null,
    secure: true,
    defaultFolder: DEFAULT_FOLDER,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    allowedExtensions: Array.from(ALLOWED_EXTENSIONS),
  };
}

/**
 * Sanitizes public_id to alphanumeric, dash, and underscore.
 * Prevents directory traversal (../) and header injection.
 */
function sanitizePublicId(id) {
  if (!id || typeof id !== 'string') return undefined;
  // Remove path traversal and illegal characters
  const clean = id.replace(/[^a-zA-Z0-9_\-\/]/g, '').replace(/\.{2,}/g, '');
  return clean.replace(/^\/+|\/+$/g, '') || undefined;
}

/**
 * Validates a file's mime type and size against security policies.
 */
function validateFile({ mimetype, size, originalname }) {
  if (size && size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File size exceeds security limit of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB`);
  }

  if (mimetype && !ALLOWED_MIME_TYPES.has(mimetype.toLowerCase())) {
    throw new Error(`MIME type '${mimetype}' is not permitted for storage. Allowed: images, PDF, CSV, JSON.`);
  }

  if (originalname) {
    const ext = path.extname(originalname).replace('.', '').toLowerCase();
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(`File extension '.${ext}' is not permitted.`);
    }
  }

  return true;
}

/**
 * Uploads a buffer to Cloudinary using upload_stream.
 *
 * @param {Buffer} buffer - File buffer
 * @param {Object} [options]
 * @param {string} [options.folder] - Target folder (default: sensor-sim)
 * @param {string} [options.publicId] - Optional custom public ID
 * @param {string[]} [options.tags] - Search tags
 * @param {string} [options.resourceType] - 'image' | 'raw' | 'auto'
 * @returns {Promise<Object>} Safe upload result
 */
function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return reject(new Error('Cloudinary credentials are not configured in environment variables'));
    }

    if (!Buffer.isBuffer(buffer)) {
      return reject(new Error('uploadBuffer requires a valid Buffer'));
    }

    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      return reject(new Error(`Buffer size (${buffer.length} bytes) exceeds maximum permitted limit.`));
    }

    const folder = options.folder ? sanitizePublicId(options.folder) : DEFAULT_FOLDER;
    const publicId = sanitizePublicId(options.publicId);

    const uploadOptions = {
      folder,
      resource_type: options.resourceType || 'auto',
      secure: true,
      tags: options.tags || ['sensor-sim'],
      ...(publicId && { public_id: publicId }),
      ...(options.overwrite !== undefined && { overwrite: Boolean(options.overwrite) }),
    };

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) return reject(error);
      resolve({
        publicId: result.public_id,
        secureUrl: result.secure_url,
        url: result.secure_url, // Enforced HTTPS
        format: result.format,
        bytes: result.bytes,
        resourceType: result.resource_type,
        width: result.width || null,
        height: result.height || null,
        createdAt: result.created_at,
      });
    });

    stream.end(buffer);
  });
}

/**
 * Uploads an asset from a secure remote URL.
 * Only HTTP and HTTPS URLs are accepted.
 *
 * @param {string} remoteUrl
 * @param {Object} [options]
 * @returns {Promise<Object>} Safe upload result
 */
async function uploadUrl(remoteUrl, options = {}) {
  if (!isConfigured()) {
    throw new Error('Cloudinary credentials are not configured in environment variables');
  }

  const parsed = new URL(remoteUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Security violation: only HTTP and HTTPS URLs may be uploaded');
  }

  const folder = options.folder ? sanitizePublicId(options.folder) : DEFAULT_FOLDER;
  const publicId = sanitizePublicId(options.publicId);

  const uploadOptions = {
    folder,
    resource_type: options.resourceType || 'auto',
    secure: true,
    tags: options.tags || ['sensor-sim'],
    ...(publicId && { public_id: publicId }),
    ...(options.overwrite !== undefined && { overwrite: Boolean(options.overwrite) }),
  };

  const result = await cloudinary.uploader.upload(remoteUrl, uploadOptions);
  return {
    publicId: result.public_id,
    secureUrl: result.secure_url,
    url: result.secure_url,
    format: result.format,
    bytes: result.bytes,
    resourceType: result.resource_type,
    width: result.width || null,
    height: result.height || null,
    createdAt: result.created_at,
  };
}

/**
 * Uploads a local file path securely.
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function uploadFilePath(filePath, options = {}) {
  if (!isConfigured()) {
    throw new Error('Cloudinary credentials are not configured in environment variables');
  }

  const folder = options.folder ? sanitizePublicId(options.folder) : DEFAULT_FOLDER;
  const publicId = sanitizePublicId(options.publicId);

  const uploadOptions = {
    folder,
    resource_type: options.resourceType || 'auto',
    secure: true,
    tags: options.tags || ['sensor-sim'],
    ...(publicId && { public_id: publicId }),
  };

  const result = await cloudinary.uploader.upload(filePath, uploadOptions);
  return {
    publicId: result.public_id,
    secureUrl: result.secure_url,
    url: result.secure_url,
    format: result.format,
    bytes: result.bytes,
    resourceType: result.resource_type,
    width: result.width || null,
    height: result.height || null,
    createdAt: result.created_at,
  };
}

/**
 * Generates an optimized, secure (HTTPS) delivery URL with transformations.
 * Supports auto-format and auto-quality optimization by default.
 *
 * @param {string} publicId
 * @param {Object} [transformations]
 * @returns {string} Secure HTTPS delivery URL
 */
function getOptimizedUrl(publicId, transformations = {}) {
  if (!publicId) return '';

  const options = {
    secure: true,
    fetch_format: transformations.format || 'auto',
    quality: transformations.quality || 'auto',
    ...(transformations.width && { width: Number(transformations.width) }),
    ...(transformations.height && { height: Number(transformations.height) }),
    ...(transformations.crop && { crop: transformations.crop }),
    ...(transformations.gravity && { gravity: transformations.gravity || 'auto' }),
  };

  return cloudinary.url(publicId, options);
}

/**
 * Generates a signed upload signature for secure direct client-side uploads.
 * This ensures the client/frontend can upload directly to Cloudinary without
 * ever having access to the API_SECRET.
 *
 * @param {Object} paramsToSign
 * @returns {Object} Payload with signature, timestamp, apiKey, cloudName
 */
function generateSignedUploadParams(paramsToSign = {}) {
  if (!isConfigured()) {
    throw new Error('Cloudinary credentials are not configured in environment variables');
  }

  const cfg = cloudinary.config();
  const timestamp = Math.round(new Date().getTime() / 1000);
  const folder = paramsToSign.folder ? sanitizePublicId(paramsToSign.folder) : DEFAULT_FOLDER;

  const payload = {
    timestamp,
    folder,
    ...paramsToSign,
  };

  const signature = cloudinary.utils.api_sign_request(payload, cfg.api_secret);

  return {
    signature,
    timestamp,
    apiKey: cfg.api_key,
    cloudName: cfg.cloud_name,
    folder,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cfg.cloud_name}/auto/upload`,
  };
}

/**
 * Securely deletes an asset from Cloudinary storage.
 *
 * @param {string} publicId
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function deleteAsset(publicId, options = {}) {
  if (!isConfigured()) {
    throw new Error('Cloudinary credentials are not configured in environment variables');
  }

  const cleanId = sanitizePublicId(publicId);
  if (!cleanId) {
    throw new Error('A valid publicId is required for deletion');
  }

  const result = await cloudinary.uploader.destroy(cleanId, {
    resource_type: options.resourceType || 'image',
    invalidate: true,
  });

  return result;
}

module.exports = {
  cloudinary,
  isConfigured,
  getStatus,
  sanitizePublicId,
  validateFile,
  uploadBuffer,
  uploadUrl,
  uploadFilePath,
  getOptimizedUrl,
  generateSignedUploadParams,
  deleteAsset,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
};
