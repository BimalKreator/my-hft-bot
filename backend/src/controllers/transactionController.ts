import { Response } from 'express';
import { query } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

const IST = 'Asia/Kolkata';

function todayIST(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: IST });
}

export async function addTransaction(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { type, amount, note, transaction_date: txDate } = req.body;
    if (!type || (type !== 'DEPOSIT' && type !== 'WITHDRAWAL')) {
      res.status(400).json({ error: 'type must be DEPOSIT or WITHDRAWAL' });
      return;
    }
    const amountNum = typeof amount === 'number' ? amount : parseFloat(String(amount));
    if (Number.isNaN(amountNum)) {
      res.status(400).json({ error: 'amount must be a number' });
      return;
    }

    const date = txDate && /^\d{4}-\d{2}-\d{2}$/.test(String(txDate))
      ? String(txDate)
      : todayIST();

    const result = await query<{ id: number }>(
      `INSERT INTO deposits_withdrawals (user_id, date, type, amount, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, date, type, amountNum, note ?? null]
    );
    const row = result.rows[0];
    res.status(201).json({ id: row?.id ?? 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to add transaction';
    res.status(500).json({ error: msg });
  }
}

export async function getTransactions(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const result = await query<{
      id: number;
      date: string;
      type: string;
      amount: string;
      note: string | null;
    }>(
      `SELECT id, date, type, amount, note
       FROM deposits_withdrawals
       WHERE user_id = $1
       ORDER BY date DESC, id DESC`,
      [userId]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch transactions';
    res.status(500).json({ error: msg });
  }
}

export async function deleteTransaction(
  req: AuthRequest,
  res: Response
): Promise<void> {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id) || id < 1) {
      res.status(400).json({ error: 'Invalid transaction id' });
      return;
    }

    const result = await query(
      `DELETE FROM deposits_withdrawals WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to delete transaction';
    res.status(500).json({ error: msg });
  }
}
