import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { getSettingsHandler, updateSettingsHandler, transferFundsHandler, triggerMockHandler, cancelMockHandler } from '../controllers/settingsController.js';

const router = Router();

router.get('/', authenticateToken, getSettingsHandler);
router.put('/', authenticateToken, updateSettingsHandler);
router.post('/transfer-funds', authenticateToken, transferFundsHandler);
router.post('/trigger-mock', authenticateToken, triggerMockHandler);
router.post('/cancel-mock', authenticateToken, cancelMockHandler);

export default router;
