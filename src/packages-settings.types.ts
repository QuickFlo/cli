/** Wire contracts from the platform's package-settings*.schema.ts.
 * The server owns schema validation, projection, bindings and concurrency.
 */
export interface PackageSettingsValueSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  title?: string;
  description?: string;
  properties?: Record<string, PackageSettingsValueSchema>;
  required?: string[];
  additionalProperties?: boolean | PackageSettingsValueSchema;
  items?: PackageSettingsValueSchema;
  contains?: PackageSettingsValueSchema;
  enum?: Array<string | number | boolean | null>;
  default?: unknown;
  readOnly?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  format?: 'email' | 'date' | 'date-time' | 'time' | 'textarea';
  'x-enum-labels'?: Record<string, string>;
  'x-quickforms-quasar'?: { keyLabel?: string; valueLabel?: string };
  'x-render'?: 'keyvalue' | 'textarea-array';
  'x-options-fetcher'?: {
    kind: 'package-provider';
    provider: 'five9.lists';
    connectionPeerDep: string;
  };
}

interface SettingsSourceBase {
  schemaVersion: 1;
  title: string;
  description?: string;
  valueSchema: PackageSettingsValueSchema;
  writablePaths: string[];
  allowCreate: boolean;
  allowDelete: boolean;
}

export type PackageSettingsSource =
  & SettingsSourceBase
  & (
    | { mode: 'singleton'; key: string; initialValue?: Record<string, unknown> }
    | {
      mode: 'collection';
      keyLabel: string;
      /** Exact record key -> declared JSON-pointer field path -> help text. */
      recordFieldDescriptions?: Record<string, Record<string, string>>;
    }
  );

export interface PackageSettingsResponse {
  packageVersionId: string;
  sources: Array<{ id: string; tableName: string; settings: PackageSettingsSource }>;
}

export interface PackageSettingsRecord {
  key: string;
  value: Record<string, unknown>;
  revision: string | null;
  issues: Array<{ path: string; message: string }>;
}

export interface PackageSettingsRecordsResponse {
  records: PackageSettingsRecord[];
  hasMore: boolean;
}

export interface PackageSettingsOptionsResponse {
  items: Array<{ value: string; label: string; disable?: boolean }>;
  nextCursor: string | null;
}
