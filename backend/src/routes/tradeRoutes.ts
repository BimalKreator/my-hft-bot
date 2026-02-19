import { Router } from 'express';
import { executeTrade } from '../controllers/tradeController.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/execute', authenticateToken, executeTrade);

export default router;
