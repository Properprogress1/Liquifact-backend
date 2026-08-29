/**
 * LiquiFact API Gateway
 * Express server bootstrap for invoice financing, auth, and Stellar integration.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit');
const { authenticateToken } = require('./middleware/auth');
const { createCorsOptions } = require('./config/cors');
const { parseDueDate } = require('./utils/dueDate');
const { callSorobanContract } = require('./services/soroban');

const PORT = process.env.PORT || 3001;

/**
 * In-memory storage for invoices (Issue #25).
 * Each invoice records a tenantId so worker/client expiry checks stay isolated.
 */
let invoices = [];

const app = express();

/**
 * Global middleware.
 */
app.use(cors(createCorsOptions()));
app.use(express.json());
app.use(globalLimiter);

/**
 * Determines whether an invoice is visible to the requesting tenant.
 * Unauthenticated requests see everything (public list behavior); authenticated
 * requests see their own invoices or unclaimed/public invoices.
 *
 * @param {Object} invoice - Stored invoice.
 * @param {Object | undefined} user - Decoded JWT user.
 * @returns {boolean} True when the invoice is visible to the caller.
 */
function isTenantVisible(invoice, user) {
  if (!user) {
    return true;
  }

  return invoice.tenantId === null || invoice.tenantId === user.id;
}

/**
 * Finds an invoice that the requesting tenant is allowed to access.
 *
 * @param {string} id - Invoice identifier.
 * @param {Object | undefined} user - Decoded JWT user.
 * @returns {Object | undefined} The invoice, if visible.
 */
function findOwnInvoice(id, user) {
  return invoices.find((inv) => inv.id === id && isTenantVisible(inv, user));
}

/**
 * Health check endpoint.
 * Returns the current status and version of the service.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/health', (req, res) => {
  return res.json({
    status: 'ok',
    service: 'liquifact-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * API information endpoint.
 * Lists available endpoints and service description.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/api', (req, res) => {
  return res.json({
    name: 'LiquiFact API',
    description: 'Global Invoice Liquidity Network on Stellar',
    endpoints: {
      health: 'GET /health',
      invoices: 'GET/POST /api/invoices',
      escrow: 'GET/POST /api/escrow',
    },
  });
});

/**
 * Lists tokenized invoices.
 * Filters out soft-deleted records unless explicitly requested.
 * Authenticated callers see only invoices visible to their tenant.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.get('/api/invoices', (req, res) => {
  const includeDeleted = req.query.includeDeleted === 'true';
  const user = req.user;

  const filteredInvoices = invoices.filter((inv) => {
    if (!includeDeleted && inv.deletedAt) {
      return false;
    }

    return isTenantVisible(inv, user);
  });

  return res.json({
    data: filteredInvoices,
    message: includeDeleted ? 'Showing all invoices (including deleted).' : 'Showing active invoices.',
  });
});

/**
 * Validates and uploads a new invoice.
 * Requires authentication and is rate-limited as a sensitive operation.
 * Due dates are normalized to UTC and returned as structured field errors
 * when invalid, missing a timezone, or impossible.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.post('/api/invoices', authenticateToken, sensitiveLimiter, (req, res) => {
  const { amount, customer, dueDate } = req.body;

  const fields = {};

  if (amount === undefined || amount === null || amount === '') {
    fields.amount = 'Amount is required';
  }

  if (customer === undefined || customer === null || customer === '') {
    fields.customer = 'Customer is required';
  }

  const dueDateResult = parseDueDate(dueDate);

  if (dueDateResult.error) {
    fields.dueDate = dueDateResult.error;
  }

  if (Object.keys(fields).length > 0) {
    return res.status(400).json({
      error: {
        message: 'Validation failed',
        fields,
      },
    });
  }

  const newInvoice = {
    id: `inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    amount,
    customer,
    tenantId: req.user ? req.user.id : null,
    status: 'pending_verification',
    dueDate: dueDateResult.dueDateUTC,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  };

  invoices.push(newInvoice);

  return res.status(201).json({
    data: newInvoice,
    message: 'Invoice uploaded successfully.',
  });
});

/**
 * Performs a soft delete on an invoice.
 * Sets the deletedAt timestamp instead of removing the record.
 * Restricted to the owning tenant.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.delete('/api/invoices/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  const invoice = findOwnInvoice(id, req.user);

  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  if (invoice.deletedAt) {
    return res.status(400).json({ error: 'Invoice is already deleted' });
  }

  invoice.deletedAt = new Date().toISOString();

  return res.json({
    message: 'Invoice soft-deleted successfully.',
    data: invoice,
  });
});

/**
 * Restores a soft-deleted invoice.
 * Resets the deletedAt timestamp to null.
 * Restricted to the owning tenant.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.patch('/api/invoices/:id/restore', authenticateToken, (req, res) => {
  const { id } = req.params;
  const invoice = findOwnInvoice(id, req.user);

  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  if (!invoice.deletedAt) {
    return res.status(400).json({ error: 'Invoice is not deleted' });
  }

  invoice.deletedAt = null;

  return res.json({
    message: 'Invoice restored successfully.',
    data: invoice,
  });
});

/**
 * Retrieves escrow state for a specific invoice.
 * Robust integration wrapper for Soroban contract interaction.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {Promise<void>}
 */
app.get('/api/escrow/:invoiceId', async (req, res) => {
  const { invoiceId } = req.params;

  try {
    /**
     * Reads the escrow state from the Soroban contract.
     *
     * @returns {Promise<{invoiceId: string, status: string, fundedAmount: number}>} Escrow state.
     */
    const operation = async () => {
      return { invoiceId, status: 'not_found', fundedAmount: 0 };
    };

    const data = await callSorobanContract(operation);

    return res.json({
      data,
      message: 'Escrow state read from Soroban contract via robust integration wrapper.',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Error fetching escrow state' });
  }
});

/**
 * Escrow write operation placeholder.
 * Protected by auth and the sensitive rate limiter.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @returns {void}
 */
app.post('/api/escrow', authenticateToken, sensitiveLimiter, (req, res) => {
  return res.json({
    data: { status: 'funded' },
    message: 'Escrow operation processed.',
  });
});

/**
 * 404 handler for unknown routes and deliberate error-test trigger.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} next - The next middleware function.
 * @returns {void}
 */
app.use((req, res, next) => {
  if (req.path === '/error-test-trigger') {
    return next(new Error('Test error'));
  }

  return res.status(404).json({ error: 'Not found', path: req.path });
});

/**
 * Global error handler.
 * Logs the error and returns a generic 500 response to avoid leaking
 * internal details. Structured field errors are returned for validation errors.
 *
 * @param {Error} err - The error object.
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} _next - The next middleware function.
 * @returns {void}
 */
app.use((err, req, res, _next) => {
  console.error(err);

  if (err.statusCode === 400 && err.fields) {
    return res.status(400).json({
      error: {
        message: err.message,
        fields: err.fields,
      },
    });
  }

  return res.status(500).json({ error: 'Internal server error' });
});

/**
 * Starts the Express server.
 *
 * @returns {import('http').Server} The started server.
 */
const startServer = () => {
  const server = app.listen(PORT, () => {
    console.warn(`LiquiFact API running at http://localhost:${PORT}`);
  });
  return server;
};

/**
 * Resets the in-memory store (for testing purposes).
 *
 * @returns {void}
 */
const resetStore = () => {
  invoices = [];
};

// Start server if not in test mode
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

// Export app and state for testing
module.exports = app;
app.app = app;
app.startServer = startServer;
app.resetStore = resetStore;
