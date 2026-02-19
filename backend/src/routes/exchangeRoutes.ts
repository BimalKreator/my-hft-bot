import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { addKeys, getBalance } from '../controllers/exchangeController.js';

const router = Router();

router.post('/add', authenticateToken, addKeys);
router.get('/balance', authenticateToken, getBalance);

export default router;
