const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, resetStore, startServer } = require('./index');

describe('LiquiFact API', () => {
  const secret = process.env.JWT_SECRET || 'test-secret';
  const createToken = (id) => jwt.sign({ id: id || Math.random().toString(36).slice(2) }, secret);

  beforeEach(() => {
    resetStore();
  });

  describe('Health & Info', () => {
    it('GET /health - returns 200 and status ok', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
    });

    it('GET /api - returns 200 and API info', async () => {
      const response = await request(app).get('/api');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name', 'LiquiFact API');
    });
  });

  describe('Invoices Lifecycle', () => {
    it('POST /api/invoices - creates a new invoice', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('create')}`)
        .send({
          amount: 1000,
          customer: 'Test Corp',
          dueDate: '2099-01-01T00:00:00Z',
        });

      expect(response.status).toBe(201);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data.amount).toBe(1000);
      expect(response.body.data.customer).toBe('Test Corp');
      expect(response.body.data.dueDate).toBe('2099-01-01T00:00:00.000Z');
      expect(response.body.data.deletedAt).toBeNull();
    });

    it('POST /api/invoices - fails if missing fields', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('missing-fields')}`)
        .send({ amount: 1000 });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('GET /api/invoices - lists active invoices', async () => {
      const token = createToken('list');
      await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 1000, customer: 'A', dueDate: '2099-01-01T00:00:00Z' });
      await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 2000, customer: 'B', dueDate: '2099-01-02T00:00:00Z' });

      const response = await request(app).get('/api/invoices');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
    });

    it('DELETE /api/invoices/:id - soft deletes an invoice', async () => {
      const token = createToken('delete');
      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 500, customer: 'Delete Me', dueDate: '2099-01-01T00:00:00Z' });
      const id = postRes.body.data.id;

      const delRes = await request(app)
        .delete(`/api/invoices/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.deletedAt).not.toBeNull();

      // Verify it's hidden from default list
      const listRes = await request(app).get('/api/invoices');
      expect(listRes.body.data).toHaveLength(0);

      // Verify it's visible with includeDeleted=true
      const listAllRes = await request(app).get('/api/invoices?includeDeleted=true');
      expect(listAllRes.body.data).toHaveLength(1);
    });

    it('DELETE /api/invoices/:id - fails for non-existent or already deleted', async () => {
      const token = createToken('delete-fail');
      const res404 = await request(app)
        .delete('/api/invoices/nonexistent')
        .set('Authorization', `Bearer ${token}`);
      expect(res404.status).toBe(404);

      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100, customer: 'X', dueDate: '2099-01-01T00:00:00Z' });
      const id = postRes.body.data.id;
      await request(app)
        .delete(`/api/invoices/${id}`)
        .set('Authorization', `Bearer ${token}`);

      const res400 = await request(app)
        .delete(`/api/invoices/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res400.status).toBe(400);
      expect(res400.body.error).toBe('Invoice is already deleted');
    });

    it('PATCH /api/invoices/:id/restore - restores a deleted invoice', async () => {
      const token = createToken('restore');
      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100, customer: 'X', dueDate: '2099-01-01T00:00:00Z' });
      const id = postRes.body.data.id;
      await request(app)
        .delete(`/api/invoices/${id}`)
        .set('Authorization', `Bearer ${token}`);

      const restoreRes = await request(app)
        .patch(`/api/invoices/${id}/restore`)
        .set('Authorization', `Bearer ${token}`);
      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.data.deletedAt).toBeNull();

      const listRes = await request(app).get('/api/invoices');
      expect(listRes.body.data).toHaveLength(1);
    });

    it('PATCH /api/invoices/:id/restore - fails for non-existent or not deleted', async () => {
      const token = createToken('restore-fail');
      const res404 = await request(app)
        .patch('/api/invoices/nonexistent/restore')
        .set('Authorization', `Bearer ${token}`);
      expect(res404.status).toBe(404);

      const postRes = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 100, customer: 'X', dueDate: '2099-01-01T00:00:00Z' });
      const id = postRes.body.data.id;

      const res400 = await request(app)
        .patch(`/api/invoices/${id}/restore`)
        .set('Authorization', `Bearer ${token}`);
      expect(res400.status).toBe(400);
      expect(res400.body.error).toBe('Invoice is not deleted');
    });
  });

  describe('Due Date Validation', () => {
    it('normalizes UTC input to UTC before persistence', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('utc')}`)
        .send({ amount: 100, customer: 'UTC', dueDate: '2099-08-30T10:00:00Z' });

      expect(response.status).toBe(201);
      expect(response.body.data.dueDate).toBe('2099-08-30T10:00:00.000Z');
    });

    it('normalizes offset input to UTC', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('offset')}`)
        .send({ amount: 100, customer: 'Offset', dueDate: '2099-08-30T10:00:00+02:00' });

      expect(response.status).toBe(201);
      expect(response.body.data.dueDate).toBe('2099-08-30T08:00:00.000Z');
    });

    it('accepts a missing due date', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('missing-due')}`)
        .send({ amount: 100, customer: 'No Due' });

      expect(response.status).toBe(201);
      expect(response.body.data.dueDate).toBeNull();
    });

    it('rejects a due date without an explicit timezone', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('no-tz')}`)
        .send({ amount: 100, customer: 'No TZ', dueDate: '2099-08-30T10:00:00' });

      expect(response.status).toBe(400);
      expect(response.body.error.fields).toHaveProperty('dueDate');
    });

    it('rejects an impossible calendar date', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('bad-cal')}`)
        .send({ amount: 100, customer: 'Bad Cal', dueDate: '2099-02-30T00:00:00Z' });

      expect(response.status).toBe(400);
      expect(response.body.error.fields).toHaveProperty('dueDate');
    });

    it('normalizes a DST boundary input with explicit offset', async () => {
      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('dst')}`)
        .send({ amount: 100, customer: 'DST', dueDate: '2027-03-14T02:30:00-05:00' });

      expect(response.status).toBe(201);
      expect(response.body.data.dueDate).toBe('2027-03-14T07:30:00.000Z');
    });

    it('rejects a past due date at the boundary', async () => {
      const fixedNow = Date.parse('2099-01-01T00:00:00.000Z');
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

      const response = await request(app)
        .post('/api/invoices')
        .set('Authorization', `Bearer ${createToken('past')}`)
        .send({ amount: 100, customer: 'Past', dueDate: '2099-01-01T00:00:00.000Z' });

      expect(response.status).toBe(400);
      expect(response.body.error.fields).toHaveProperty('dueDate');

      nowSpy.mockRestore();
    });
  });

  describe('Error Handling', () => {
    it('unknown route - returns 404', async () => {
      const response = await request(app).get('/unknown');
      expect(response.status).toBe(404);
    });

    it('error handler - returns 500 on unexpected error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const response = await request(app).get('/error-test-trigger');
      expect(response.status).toBe(500);
      consoleSpy.mockRestore();
    });
  });

  describe('Escrow', () => {
    it('GET /api/escrow/:invoiceId - returns placeholder escrow state', async () => {
      const response = await request(app).get('/api/escrow/123');
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('invoiceId', '123');
    });
  });

  describe('Server', () => {
    it('startServer - starts the server and returns it', () => {
      const mockServer = { close: jest.fn() };
      const listenSpy = jest.spyOn(app, 'listen').mockImplementation((port, cb) => {
        if (cb) { cb(); }
        return mockServer;
      });

      const server = startServer();
      expect(listenSpy).toHaveBeenCalled();
      expect(server).toBe(mockServer);

      listenSpy.mockRestore();
    });
  });
});
