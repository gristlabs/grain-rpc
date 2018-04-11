import {assert, use} from "chai";
import * as chaiAsPromised from "chai-as-promised";
import {createCheckers} from "ts-interface-checker";
import {Rpc} from "../lib/rpc";
import {ICalc} from "./ICalc";
import ICalcTI from "./ICalc-ti";

use(chaiAsPromised);

const checkersForICalc = createCheckers(ICalcTI).ICalc;

class Calc implements ICalc {
  public add(x: number, y: number): number {
    return x + y;
  }
}

interface IGreet {
  getGreeting(name: string): Promise<string>;
}

class MyGreeting implements IGreet {
  public async getGreeting(name: string): Promise<string> { return `Hello, ${name}!`; }
}

const defaults = { logger: {} };

describe("Rpc", () => {

  describe("basics", () => {

    it("should be able to make unchecked stubs and call methods", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc());
      const stub = rpc.getStub<ICalc>("calc");
      assert(stub);
      assert.equal(await stub.add(4, 5), 9);
    });

    it("should support hello world without a checker", async () => {
      const aRpc = new Rpc(defaults);
      const bRpc = new Rpc(defaults);
      aRpc.start((msg) => bRpc.receiveMessage(msg));
      bRpc.start((msg) => aRpc.receiveMessage(msg));
      aRpc.registerImpl("my-greeting", new MyGreeting());
      const stub = bRpc.getStub<IGreet>("my-greeting");
      assert.equal(await stub.getGreeting("World"), "Hello, World!");
    });

  });

  describe("getStub", () => {

    it("should be able to return safely from async methods", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc());
      // Unchecked stubs will not return well from async methods if they look thenable
      // and javascript code results in a Promise.resolve.
      async function getCalc() {
        return rpc.getStub<ICalc>("calc");
      }
      const stub = await getCalc();
      assert(stub);
      assert.equal(await stub.add(4, 5), 9);
    });

    it("should be able to pass through Promise.resolve", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc());
      const stub = Promise.resolve(rpc.getStub<ICalc>("calc"));
      assert.equal(await stub.then(calc => calc.add(4, 5)), 9);
    });

  });

  describe("checker", () => {

    it("should allow calling methods that exist", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc(), checkersForICalc);
      const stub = rpc.getStub<ICalc>("calc", checkersForICalc);
      assert.equal(await stub.add(4, 5), 9);
    });

    it("should catch missing methods at typed stub", async () => {
      const rpc = new Rpc(defaults);
      const stub = rpc.getStub<ICalc>("calc", checkersForICalc);
      // "any" cast needed to avoid typescript catching the error
      assert.throws(() => (stub as any).additionify(4, 5), /is not a function/);
    });

    it("should catch missing methods at implementation for untyped stub", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc(), checkersForICalc);
      const stub = rpc.getStub<ICalc>("calc");
      await assert.isRejected(stub.additionify(4, 5), /Unknown method/);
    });

    it("should catch bad + missing arguments at implementation", async () => {
      const rpc = new Rpc(defaults);
      rpc.start((msg) => rpc.receiveMessage(msg));
      rpc.registerImpl<ICalc>("calc", new Calc(), checkersForICalc);
      const stub = rpc.getStub<ICalc>("calc");
      await assert.isRejected(stub.add("hello", 5), /not a number/);
      await assert.isRejected(stub.add(), /value.x is missing/);
      await assert.isRejected(stub.add(1), /value.y is missing/);
      await assert.equal(await stub.add(10, 9, 8), 19);  // by default, extra args are allowed
    });
  });
});
