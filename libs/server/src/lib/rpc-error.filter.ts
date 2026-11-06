import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { throwError, type Observable } from 'rxjs';

/**
 * NestJS replaces the message of any non-RpcException error with "Internal
 * server error" before it crosses the TCP transport. Our services throw plain
 * Errors with messages written for humans, so re-wrap them and keep the text.
 */
@Catch()
export class RpcErrorFilter implements ExceptionFilter {
  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    return throwError(
      () => new RpcException({ message: describe(exception), statusCode: 400 }),
    );
  }
}

function describe(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.message;
  }
  if (exception && typeof exception === 'object' && 'message' in exception) {
    const value = (exception as { message?: unknown }).message;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return String(exception);
}
