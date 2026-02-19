import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { getBanned, addBan, removeBan } from '../controllers/banController.js';

const router = Router();

router.get('/', authenticateToken, getBanned);
router.post('/add', authenticateToken, addBan);
router.post('/remove', authenticateToken, removeBan);

export default router;
