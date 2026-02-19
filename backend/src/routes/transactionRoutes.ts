import { Router } from 'express';
import {
  addTransaction,
  getTransactions,
  deleteTransaction,
} from '../controllers/transactionController.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/', authenticateToken, addTransaction);
router.get('/', authenticateToken, getTransactions);
router.delete('/:id', authenticateToken, deleteTransaction);

export default router;
