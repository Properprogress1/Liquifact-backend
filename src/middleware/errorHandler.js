/**
 * Global error handling middleware
 * Ensures consistent error responses and prevents stack leaks in production.
 *
 * @param {Error} err - The thrown error.
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {import('express').NextFunction} _next - The next middleware function.
 * @returns {void}
 */
const errorHandler = (err, req, res, _next) => {
  console.error(err);

  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    error: {
      message:
        process.env.NODE_ENV === 'production'
          ? 'Internal server error'
          : err.message,
    },
  });
};

module.exports = errorHandler;
