import type { Request, Response, NextFunction } from "express";

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  [key: string]: any;
}

export class AppError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail: string,
    public type: string = 'about:blank',
    public extra?: Record<string, any>
  ) {
    super(detail);
    this.name = 'AppError';
  }
}

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // If headers already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(err);
  }
  
  console.error('Error:', err);
  
  let problemDetail: ProblemDetail;
  
  if (err instanceof AppError) {
    problemDetail = {
      type: err.type,
      title: err.title,
      status: err.status,
      detail: err.detail,
      instance: req.url,
      ...err.extra,
    };
  } else if (err.name === 'ValidationError' || err.validation) {
    problemDetail = {
      type: 'https://nutrition-app.com/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Request validation failed',
      instance: req.url,
      errors: err.validation || err.details,
    };
  } else if (err.code === '23505') { // PostgreSQL unique violation
    problemDetail = {
      type: 'https://nutrition-app.com/duplicate-resource',
      title: 'Duplicate Resource',
      status: 409,
      detail: 'A resource with this identifier already exists',
      instance: req.url,
    };
  } else if (err.code === '23503') { // PostgreSQL foreign key violation
    problemDetail = {
      type: 'https://nutrition-app.com/reference-error',
      title: 'Reference Error',
      status: 400,
      detail: 'Referenced resource does not exist',
      instance: req.url,
    };
  } else if (err.code === '42703') { // PostgreSQL undefined_column
    problemDetail = {
      type: 'https://nutrition-app.com/schema-out-of-date',
      title: 'Database Schema Out of Date',
      status: 503,
      detail: 'A required database column is missing. Run the latest migrations (e.g. migrations/009_meal_plan_ai_columns.sql) against the database used by DATABASE_URL.',
      instance: req.url,
      migration: '009_meal_plan_ai_columns.sql',
    };
  } else if (
    (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ||
    (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600)
  ) {
    // Errors thrown with .status/.statusCode set (e.g. meal plan "no recipes", not found)
    const status = typeof err.status === 'number' ? err.status : err.statusCode;
    problemDetail = {
      type: 'about:blank',
      title: status === 404 ? 'Not Found' : status === 422 ? 'Unprocessable Entity' : 'Error',
      status,
      detail: err.message || 'An error occurred',
      instance: req.url,
    };
  } else {
    problemDetail = {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred',
      instance: req.url,
    };
  }
  
  res
    .status(problemDetail.status)
    .type('application/problem+json')
    .json(problemDetail);
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: `No resource found at ${req.path}`,
    instance: req.url,
  });
}
