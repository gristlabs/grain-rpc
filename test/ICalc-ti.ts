import * as t from "ts-interface-checker";
// tslint:disable:object-literal-key-quotes

export const ICalc = t.iface([], {
  "add": t.func("number", t.param("x", "number"), t.param("y", "number")),
});

const exportedTypeSuite: t.ITypeSuite = {
  ICalc,
};
export default exportedTypeSuite;
