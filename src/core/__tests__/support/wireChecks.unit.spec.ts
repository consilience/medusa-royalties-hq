import { answerErrors, payloadErrors, setWireChecks } from "./wireChecks";

describe("wire checks", () => {
  afterEach(() => setWireChecks(null));

  it("report nothing until some are set", () => {
    setWireChecks(null);
    expect(payloadErrors({})).toEqual([]);
    expect(answerErrors("get", 200, {})).toEqual([]);
  });

  it("run the checks that were set", () => {
    setWireChecks({
      payload: () => ["bad payload"],
      answer: (operation, status) => [`bad ${operation} ${status}`],
    });
    expect(payloadErrors({})).toEqual(["bad payload"]);
    expect(answerErrors("put", 409, {})).toEqual(["bad put 409"]);
  });
});
