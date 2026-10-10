export const G12G2_LOCAL_INTEGRATION_URI = 'mongodb://127.0.0.1:27029/?replicaSet=rs0';

export interface G12g2LocalIntegrationTarget {
  readonly uri: typeof G12G2_LOCAL_INTEGRATION_URI;
  readonly databaseName: string;
}

/** Fail closed before any Mongo client or destructive fixture operation exists. */
export function assertG12g2LocalIntegrationTarget(
  uri: string,
  databaseName: string,
): G12g2LocalIntegrationTarget {
  if (uri !== G12G2_LOCAL_INTEGRATION_URI || !/^passhub_g12g2_[1-9][0-9]*$/u.test(databaseName)) {
    throw new Error('G12G2_LOCAL_INTEGRATION_TARGET_REJECTED');
  }
  return Object.freeze({ uri: G12G2_LOCAL_INTEGRATION_URI, databaseName });
}
