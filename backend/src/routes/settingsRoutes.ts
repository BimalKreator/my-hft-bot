import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { getSettingsHandler, updateSettingsHandler, triggerMockHandler, cancelMockHandler } from '../controllers/settingsController.js';

const router = Router();

router.get('/', authenticateToken, getSettingsHandler);
router.put('/', authenticateToken, updateSettingsHandler);
router.post('/trigger-mock', authenticateToken, triggerMockHandler);
router.post('/cancel-mock', authenticateToken, cancelMockHandler);

export default router;
