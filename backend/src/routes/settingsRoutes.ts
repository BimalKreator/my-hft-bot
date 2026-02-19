import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { getSettingsHandler, updateSettingsHandler } from '../controllers/settingsController.js';

const router = Router();

router.get('/', authenticateToken, getSettingsHandler);
router.put('/', authenticateToken, updateSettingsHandler);

export default router;
