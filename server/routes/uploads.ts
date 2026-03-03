import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { requireB2cCustomerIdFromReq } from "../services/b2cIdentity.js";
import { uploadRecipeImage, deleteRecipeImage } from "../services/imageUpload.js";
import multer from "multer";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (_req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/webp"];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only JPEG, PNG, and WebP images are allowed"));
        }
    },
});

const router = Router();

/**
 * POST /api/v1/uploads/recipe-image
 * Uploads a recipe cover image to Supabase Storage.
 * Body: multipart/form-data { file, recipeId? }
 * Returns: { url: string }
 *
 * Folder structure: recipe-images/{customerId}/{recipeId}/image.webp
 */
router.post(
    "/recipe-image",
    authMiddleware,
    upload.single("file"),
    async (req, res, next) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: "No file uploaded" });
            }

            const b2cCustomerId = requireB2cCustomerIdFromReq(req);
            const recipeId = req.body?.recipeId || crypto.randomUUID();

            const url = await uploadRecipeImage(
                req.file.buffer,
                req.file.mimetype,
                b2cCustomerId,
                recipeId,
            );

            res.json({ url, recipeId });
        } catch (err) {
            next(err);
        }
    },
);

/**
 * DELETE /api/v1/uploads/recipe-image/:recipeId
 * Deletes the recipe image from Supabase Storage.
 */
router.delete(
    "/recipe-image/:recipeId",
    authMiddleware,
    async (req, res, next) => {
        try {
            const b2cCustomerId = requireB2cCustomerIdFromReq(req);
            await deleteRecipeImage(b2cCustomerId, req.params.recipeId);
            res.status(204).end();
        } catch (err) {
            next(err);
        }
    },
);

export default router;
