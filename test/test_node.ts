import {assert} from "chai";
import {Node} from "../lib/endpoint";

import * as bluebird from "bluebird";

interface ICalc {
  add(x: number, y: number): number;
}

class Calc implements ICalc {
  public add(x: number, y: number): number {
    return x + y;
  }
}

/** Add symmetric links between two neigboring nodes.  Add delays for realism. */
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

function makeNetwork() {
  // make some nodes, representing distinct parts of program/network
  const network = {
    node1: new Node("node1"),
    node2: new Node("node2"),
    node3: new Node("node3"),
    node4: new Node("node4"),
    node5: new Node("node5"),
  };

  // hook them up any which way
  connect(1.0, 50, network.node1, network.node2);
  connect(1.0, 50, network.node2, network.node3);
  connect(0.0, 0, network.node3, network.node4);
  connect(0.0, 0, network.node3, network.node5);
  connect(10.0, 500, network.node1, network.node5);

  return network;
}

describe("Node", () => {
  it("deliver rpc message and response across network", async () => {
    const network = makeNetwork();
    // stick a service somewhere
    network.node1.registerImpl<ICalc>("backend", "calc", new Calc());
    // make a connection to the service from somewhere else
    const stub = network.node4.getStub<ICalc>("backend", "calc");
    assert.equal(await stub.add(4, 5), 9);
  });
});

describe("Node", () => {
  it("deliver plain messages across network", async () => {
    const network = makeNetwork();
    const originalMsg = {
      "hello": "there",
    };
    network.node1.listen("backend").on("message", (msg) => {
      assert.deepEqual(msg, originalMsg);
      return;
    });
    network.node4.connect("backend").postMessage(originalMsg);
  });
});
