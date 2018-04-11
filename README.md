[![Build Status](https://travis-ci.org/gristlabs/grain-rpc.svg?branch=master)](https://travis-ci.org/gristlabs/grain-rpc)


> layer a remote-procedure-call interface on top of simple messaging, using promises

You provide messaging between two endpoints, and in return you get the ability to
register interfaces or functions at either endpoint, and call them from the other side.

All you need to do is:

  1. Provide a `sendMessage()` function to deliver messages to the other side.
  2. Call `receiveMessage()` whenever a message is received.

What you get is the ability to register entire interfaces (type-checked or unchecked) on
either side, and call methods on those interfaces from the other side.  This is
particularly pleasant with typescript.  For example, if you define this interface:

```typescript
interface ICalc {
  add(x: number, y: number): number;
}
```

Then on one side you can do:

```typescript
import {ICalc} from './ICalc';
import {Rpc} from 'grain-rpc';

class Calc implements ICalc {
  public add(x: number, y: number): number {
    return x + y;
  }
}

const rpc = new Rpc();
rpc.start(yourSendMessageFunction);  // also be sure send messages to rpc.receiveMessage()
rpc.registerImpl<ICalc>("calc", new Calc());
```

And on the other side you can do:

```typescript
import {ICalc} from './ICalc';
import {Rpc} from 'grain-rpc';

const rpc = new Rpc();
rpc.start(yourSendMessageFunction);  // also be sure send messages to rpc.receiveMessage()
rpc.getStub<ICalc>("calc");
console.log(await stub.add(4, 5));   // should print 9
```

Rpc library supports ts-interface-checker descriptors for the interfaces, to allow validation.

The string name used to register and use an implementation allows for the same Rpc object to be
used to expose multiple interfaces, or different implementations of the same interface.

Rpc also supports a messaging interface, with `postMessage()` to send arbitrary messages, and an
`EventEmitter` interface for "message" events to receive them, e.g. `on("message", ...)`. So if you
need to multiplex non-Rpc messages over the same channel, Rpc class does it for you.
