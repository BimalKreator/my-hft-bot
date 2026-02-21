import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { closePosition } from '../controllers/positionController.js';

const router = Router();

router.post('/close', authenticateToken, closePosition);

export default router;
