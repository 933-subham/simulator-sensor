/**
 * src/routes/storage.js
 * ─────────────────────────────────────────────────────────────
 * Secure Cloudinary Storage Endpoints.
 *
 * GET    /api/storage/status       Storage configuration status & limits (secrets masked)
 * POST   /api/storage/upload       Secure file/image/document upload (multipart, JSON url, or base64)
 * POST   /api/storage/sign         Generate signed parameters for secure direct-to-cloud upload
 * GET    /api/storage/url/*        Generate secure optimized delivery URL with on-the-fly transformations
 * DELETE /api/storage/*            Delete stored asset by public ID
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const multer = require('multer');
const { requireApiKey, requireOperate } = require('../middleware/auth');
const storage = require('../storage/cloudinary');

const router = express.Router();

// All storage endpoints require API key / operator authentication
router.use(requireApiKey);

// Configure multer for safe memory buffering with strict size and type filters
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: storage.MAX_FILE_SIZE_BYTES, // 10 MB limit
    files: 1,                              // 1 file per request
  },
  fileFilter: (_req, file, cb) => {
    try {
      storage.validateFile({
        mimetype: file.mimetype,
        originalname: file.originalname,
      });
      cb(null, true);
    } catch (err) {
      cb(err);
    }
  },
});

// ── GET /api/storage/status ──────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    storage: storage.getStatus(),
  });
});

// ── POST /api/storage/sign ───────────────────────────────────────────────────
// Generates a cryptographically signed payload for direct client upload
router.post('/sign', requireOperate, (req, res) => {
  try {
    const { folder, tags, publicId } = req.body || {};
    const paramsToSign = {};
    if (folder) paramsToSign.folder = folder;
    if (tags) paramsToSign.tags = Array.isArray(tags) ? tags.join(',') : tags;
    if (publicId) paramsToSign.public_id = publicId;

    const signaturePayload = storage.generateSignedUploadParams(paramsToSign);
    res.json({
      success: true,
      message: 'Signed upload parameters generated successfully. Pass these directly to Cloudinary.',
      ...signaturePayload,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/storage/upload ─────────────────────────────────────────────────
// Handles multipart file, remote URL, or base64 data upload
router.post('/upload', requireOperate, (req, res, next) => {
  upload.single('file')(req, res, async (multerErr) => {
    if (multerErr) {
      return res.status(400).json({
        error: multerErr.message || 'File upload validation error',
        limitBytes: storage.MAX_FILE_SIZE_BYTES,
      });
    }

    try {
      const { url, data, folder, publicId, tags, resourceType, overwrite } = req.body || {};

      let result;

      if (req.file) {
        // 1. Multipart buffer upload
        result = await storage.uploadBuffer(req.file.buffer, {
          folder,
          publicId: publicId || req.file.originalname?.replace(/\.[^/.]+$/, ''),
          tags: tags ? (Array.isArray(tags) ? tags : [tags]) : undefined,
          resourceType,
          overwrite,
        });
      } else if (url) {
        // 2. Remote URL upload
        result = await storage.uploadUrl(url, {
          folder,
          publicId,
          tags: tags ? (Array.isArray(tags) ? tags : [tags]) : undefined,
          resourceType,
          overwrite,
        });
      } else if (data) {
        // 3. Base64 / Data URI upload
        let buffer;
        let mimeMatch = data.match(/^data:([a-zA-Z0-9\/+-]+);base64,/);
        if (mimeMatch) {
          storage.validateFile({ mimetype: mimeMatch[1] });
          buffer = Buffer.from(data.replace(/^data:([a-zA-Z0-9\/+-]+);base64,/, ''), 'base64');
        } else {
          buffer = Buffer.from(data, 'base64');
        }

        result = await storage.uploadBuffer(buffer, {
          folder,
          publicId,
          tags: tags ? (Array.isArray(tags) ? tags : [tags]) : undefined,
          resourceType,
          overwrite,
        });
      } else {
        return res.status(400).json({
          error: 'No file or source provided. Send a multipart file as "file", a remote "url", or base64 "data".',
        });
      }

      res.status(201).json({
        success: true,
        message: 'Asset uploaded securely to Cloudinary.',
        asset: result,
      });
    } catch (err) {
      next(err);
    }
  });
});

// ── GET /api/storage/url/* ───────────────────────────────────────────────────
// Builds secure transformed URL for a given public ID
router.get('/url/*', (req, res) => {
  const publicId = req.params[0];
  if (!publicId) {
    return res.status(400).json({ error: 'Public ID is required in URL path' });
  }

  const { width, height, crop, format, quality, gravity } = req.query;
  const secureUrl = storage.getOptimizedUrl(publicId, {
    width,
    height,
    crop,
    format,
    quality,
    gravity,
  });

  res.json({
    publicId,
    secureUrl,
    transformations: {
      width: width || 'original',
      height: height || 'original',
      crop: crop || 'auto',
      format: format || 'auto',
      quality: quality || 'auto',
      gravity: gravity || 'auto',
    },
  });
});

// ── DELETE /api/storage/* ────────────────────────────────────────────────────
// Deletes an asset by public ID
router.delete('/*', requireOperate, async (req, res, next) => {
  try {
    const publicId = req.params[0];
    if (!publicId) {
      return res.status(400).json({ error: 'Public ID is required in URL path' });
    }

    const result = await storage.deleteAsset(publicId, {
      resourceType: req.query.resourceType || 'image',
    });

    res.json({
      success: true,
      publicId,
      result,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
