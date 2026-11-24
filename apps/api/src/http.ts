import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  config: AppConfig;
  requestId: string;
  url: URL;
}

export type Next = () => Promise<void>;
export type Middleware = (context: RequestContext, next: Next) => void | Promise<void>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function compose(middlewares: Middleware[]): Middleware {
  return async (context, finalNext) => {
    let index = -1;

    const dispatch = async (position: number): Promise<void> => {
      if (position <= index) throw new Error('next() called multiple times');
      index = position;
      const middleware = middlewares[position];
      if (middleware === undefined) return finalNext();
      await middleware(context, () => dispatch(position + 1));
    };

    await dispatch(0);
  };
}
