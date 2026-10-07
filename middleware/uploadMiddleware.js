const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const safeName = file.originalname.replace(/[^a-z0-9.]+/gi, '-').toLowerCase();
    cb(null, `${require('crypto').randomUUID()}-${safeName}`);
  },
});

function fileFilter(req, file, cb) {
  if (!allowedTypes.includes(file.mimetype)) return cb(new Error('Only jpg, jpeg, png and webp images are allowed'));
  cb(null, true);
}

module.exports = multer({ storage, fileFilter, limits: { fileSize: 3 * 1024 * 1024, files: 8 } });
