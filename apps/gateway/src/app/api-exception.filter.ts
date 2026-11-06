import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiError } from '@org/contracts';

/**
 * Microservice calls surface as plain Errors. Their messages are written for
 * humans ("The wiki has no pages yet..."), so return them as 400s instead of
 * leaking an opaque 500.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : 400;

    let message = 'Unexpected error';
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const value = (body as { message?: string | string[] }).message;
        message = Array.isArray(value)
          ? value.join(', ')
          : value || exception.message;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    } else if (
      exception &&
      typeof exception === 'object' &&
      'message' in exception
    ) {
      // NestJS serialises microservice errors as plain objects, so the useful
      // text ("Repository X is not connected.") is not on an Error instance.
      const value = (exception as { message?: unknown }).message;
      if (typeof value === 'string' && value.length > 0) {
        message = value;
      }
    }

    if (status >= 500) {
      this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    }

    const payload: ApiError = { statusCode: status, message: String(message) };
    response.status(status).json(payload);
  }
}
