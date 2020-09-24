type FuncType = (...args: any) => any;

export function overwriteCallback<T, K extends keyof T>(
    self: T,
    fnName: K,
    hook: (...args: any[]) => any[]
) {
    const original = self[fnName];
    if (typeof original !== 'function') {
        throw new Error(`overwrite error: ${fnName} is not a function`);
    }

    self[fnName] = ((...args: any[]) => {
        const newArgs = args.slice(0, args.length - 1);
        const lastArg = args[args.length - 1];
        if (typeof lastArg !== 'function') {
            throw new Error(
                `overwrite error: last arg of ${fnName} is not a function`
            );
        }
        newArgs.push((...callbackArgs: any[]) => {
            const newCallbackArgs = hook(...callbackArgs);
            lastArg(...newCallbackArgs);
        });
        const result = original.apply(self, newArgs);

        return result;
    }) as any;

    return () => {
        self[fnName] = original;
    };
}

export function overwrite<T, K extends keyof T, Fn extends T[K]>(
    self: T,
    fnName: K,
    hook: Fn extends FuncType
        ? (result: ReturnType<Fn>, ...args: Parameters<Fn>) => void
        : never
) {
    if (!self) return;
    if ((self[fnName] as any).replaced) return;
    const original = self[fnName];
    if (typeof original !== 'function') return;

    self[fnName] = ((...args: any[]) => {
        const result = original.apply(self, args);
        hook(result, ...args);
        return result;
    }) as any;
    (self[fnName] as any).replaced = true;

    return () => {
        self[fnName] = original;
    };
}
