import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { getNextToTrade, getSnapshots } from '../controllers/dashboardController.js';

const router = Router();

router.get('/next-to-trade', authenticateToken, getNextToTrade);
router.get('/snapshots', authenticateToken, getSnapshots);

export default router;
