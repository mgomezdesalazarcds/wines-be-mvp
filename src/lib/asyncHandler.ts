import { Request, Response, NextFunction, RequestHandler } from "express";

/** Express 4 doesn't forward a rejected promise from an async route handler
 * to error-handling middleware — it becomes an unhandled rejection and
 * crashes the whole process. Wrap every async handler with this so a DB/API
 * error turns into a 500 response instead of taking the server down. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
