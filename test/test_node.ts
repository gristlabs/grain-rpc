import {assert} from "chai";
import {Node} from "../lib/endpoint";
import {Rpc} from "../lib/rpc";

import * as bluebird from 'bluebird'

interface ICalc {
  add(x: number, y: number): number;
}

class Calc implements ICalc {
  public add(x: number, y: number): number {
    return x + y;
  }
}

/** add symmetric links between two neigboring nodes */
function connect(cost: number, delay: number, node1: Node, node2: Node): void {
  node1.addOutput(`${node1.nodeName}->${node2.nodeName}`,
                  async (msg) => {
                    if (delay) { await bluebird.delay(delay); }
                    return node2.receiveInput(`${node2.nodeName}->${node1.nodeName}`, msg);
                  },
                  cost);
  node2.addOutput(`${node2.nodeName}->${node1.nodeName}`,
                  async (msg) => {
                    if (delay) { await bluebird.delay(delay); }
                    return node1.receiveInput(`${node1.nodeName}->${node2.nodeName}`, msg);
                  },
                  cost);
}


describe("Node", () => {
  it("deliver message and response across network", async () => {
    const node1 = new Node("node1");
    const node2 = new Node("node2");
    const node3 = new Node("node3");
    const node4 = new Node("node4");
    const node5 = new Node("node5");
    connect(1.0, 50, node1, node2);
    connect(1.0, 50, node2, node3);
    connect(0.0, 0, node3, node4);
    connect(0.0, 0, node3, node5);
    connect(10.0, 500, node1, node5);

    const rpc1 = new Rpc();
    rpc1.registerImpl<ICalc>("calc", new Calc());
    node1.listen(rpc1, 'backend');

    const rpc2 = new Rpc();
    node4.connect(rpc2, 'frontend', 'backend');

    const stub = rpc2.getStub<ICalc>("calc");
    assert(stub);
    assert.equal(await stub.add(4, 5), 9);
  });
});
