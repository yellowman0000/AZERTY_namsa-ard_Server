import { HttpStatus, Logger, RequestMethod, SSE_ABORT_CONTROLLER, } from '@nestjs/common';
import { EMPTY, lastValueFrom, isObservable } from 'rxjs';
import { catchError, concatMap, map } from 'rxjs/operators';
import { SseStream, } from './sse-stream.js';
import { isNil, isObject, isString } from '@nestjs/common/internal';
export class RouterResponseController {
    applicationRef;
    logger = new Logger(RouterResponseController.name);
    constructor(applicationRef) {
        this.applicationRef = applicationRef;
    }
    async apply(result, response, httpStatusCode) {
        return this.applicationRef.reply(response, result, httpStatusCode);
    }
    async redirect(resultOrDeferred, response, redirectResponse) {
        const result = await this.transformToResult(resultOrDeferred);
        const statusCode = result && result.statusCode
            ? result.statusCode
            : redirectResponse.statusCode
                ? redirectResponse.statusCode
                : HttpStatus.FOUND;
        const url = result && result.url ? result.url : redirectResponse.url;
        this.applicationRef.redirect(response, statusCode, url);
    }
    async render(resultOrDeferred, response, template) {
        const result = await this.transformToResult(resultOrDeferred);
        return this.applicationRef.render(response, template, result);
    }
    async transformToResult(resultOrDeferred) {
        if (isObservable(resultOrDeferred)) {
            return lastValueFrom(resultOrDeferred);
        }
        return resultOrDeferred;
    }
    getStatusByMethod(requestMethod) {
        switch (requestMethod) {
            case RequestMethod.POST:
                return HttpStatus.CREATED;
            default:
                return HttpStatus.OK;
        }
    }
    setHeaders(response, headers) {
        headers.forEach(({ name, value }) => this.applicationRef.setHeader(response, name, typeof value === 'function' ? value() : value));
    }
    setStatus(response, statusCode) {
        this.applicationRef.status(response, statusCode);
    }
    async sse(result, response, request, options) {
        // It's possible that we sent headers already so don't use a stream
        if (response.writableEnded) {
            // The response is already gone: abort the request-scoped signal so
            // handler cleanup wired to @SseSignal() still runs, and swallow late
            // handler rejections that can no longer be delivered to the client.
            this.getOrCreateAbortController(request).abort();
            Promise.resolve(result).catch((err) => this.logger.error(err));
            return;
        }
        const stream = new SseStream(request);
        // Create a per-request AbortController and expose its signal on the request
        // object so async @Sse() handlers can observe client disconnects (via the
        // @SseSignal() parameter decorator) and stop/clean up in-flight setup work.
        // The controller is reused if one was already attached upstream (e.g. when the
        // handler is wrapped by interceptors and the signal was created earlier).
        const abortController = this.getOrCreateAbortController(request);
        return new Promise((resolve, reject) => {
            let settled = false;
            let subscription;
            const disconnectSource = request.socket ?? response;
            // Ends the request-scoped lifetime: stops listening for disconnects and
            // aborts the signal handed to the route handler. Every terminal path of
            // the SSE lifecycle (disconnect, completion, error) funnels through here,
            // so a handler that ties its resources to the signal releases them once,
            // regardless of how the stream ended. `abort()` is idempotent, so paths
            // that already aborted on disconnect are unaffected.
            const finalize = () => {
                disconnectSource.removeListener('close', onClose);
                abortController.abort();
            };
            const endStream = () => {
                if (!stream.writableEnded) {
                    stream.end();
                }
            };
            const onClose = () => {
                if (settled) {
                    return;
                }
                settled = true;
                finalize();
                subscription?.unsubscribe();
                endStream();
                response.end();
                resolve();
            };
            disconnectSource.once('close', onClose);
            // The client may have disconnected before the handler ran (e.g., during
            // a guard), in which case "close" has already been emitted.
            if (disconnectSource.destroyed) {
                onClose();
            }
            Promise.resolve(result)
                .then(observableResult => {
                if (settled) {
                    // Setup may resolve after the client has disconnected. Leave its
                    // producer unsubscribed, without keeping the router lifecycle open.
                    return;
                }
                this.assertObservable(observableResult);
                stream.pipe(response, {
                    additionalHeaders: options?.additionalHeaders,
                    statusCode: options?.statusCode ?? (() => response.statusCode),
                });
                subscription = observableResult
                    .pipe(map((message) => {
                    const event = isObject(message)
                        ? message
                        : { data: message };
                    // The SseStream only receives string data. Serializing here
                    // turns a JSON.stringify error (BigInts, circular references)
                    // into an error of this pipeline, handled by catchError below,
                    // instead of a throw that leaves the stream stuck mid-write.
                    // Fields are copied one by one, as a spread would drop the
                    // getters of an event implemented as a class.
                    return isNil(event.data) || isString(event.data)
                        ? event
                        : {
                            type: event.type,
                            id: event.id,
                            retry: event.retry,
                            comment: event.comment,
                            data: JSON.stringify(event.data),
                        };
                }), concatMap(message => new Promise((resolve, reject) => stream.writeMessage(message, err => err ? reject(err) : resolve()))), catchError(err => {
                    if (!stream.headersCommitted) {
                        throw err;
                    }
                    const data = err instanceof Error ? err.message : err;
                    stream.writeMessage({ type: 'error', data }, writeError => {
                        if (writeError) {
                            this.logger.error(writeError);
                        }
                    });
                    return EMPTY;
                }))
                    .subscribe({
                    error: err => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        finalize();
                        endStream();
                        reject(err);
                    },
                    complete: () => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        // An empty producer is still a successful SSE response. Commit
                        // before ending, since the deferred header task will be skipped.
                        stream.commitHeaders();
                        finalize();
                        endStream();
                        resolve();
                    },
                });
                // Guards against a "close" event emitted synchronously during
                // subscribe, before the subscription is assigned for onClose to cancel.
                if (settled) {
                    subscription.unsubscribe();
                }
                // Commit SSE headers on the next macrotask. Pipe validation errors
                // propagate through microtasks (which complete before macrotasks),
                // so if the lifecycle errored, `settled` is already true and we
                // skip the write. Otherwise headers are sent immediately rather
                // than waiting for the first Observable emission.
                setTimeout(() => {
                    if (!settled) {
                        stream.commitHeaders();
                    }
                }, 0);
            })
                .catch(err => {
                if (settled) {
                    return;
                }
                settled = true;
                finalize();
                endStream();
                reject(err);
            });
        });
    }
    assertObservable(value) {
        if (!isObservable(value)) {
            throw new ReferenceError('You must return an Observable stream to use Server-Sent Events (SSE).');
        }
    }
    getOrCreateAbortController(request) {
        const carrier = request;
        if (!carrier[SSE_ABORT_CONTROLLER]) {
            carrier[SSE_ABORT_CONTROLLER] = new AbortController();
        }
        return carrier[SSE_ABORT_CONTROLLER];
    }
}
