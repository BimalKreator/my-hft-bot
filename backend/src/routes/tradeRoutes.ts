import { Router } from 'express';
import { executeTrade, closePosition, getDashboardPositions, getTradeHistory } from '../controllers/tradeController.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/execute', authenticateToken, executeTrade);
router.post('/close', authenticateToken, closePosition);
router.get('/dashboard/positions', authenticateToken, getDashboardPositions);
router.get('/positions', authenticateToken, getDashboardPositions);
router.get('/history', authenticateToken, getTradeHistory);

export default router;
