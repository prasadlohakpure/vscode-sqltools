import { FormProps } from '@rjsf/core';
import { IConnection } from '@sqltools/types';
import uniq from 'lodash/uniq';

export default function prepareSchema(
  schema: FormProps<IConnection>['schema'],
  uiSchema: FormProps<IConnection>['uiSchema'] = {}
): {
  schema: FormProps<IConnection>['schema'];
  uiSchema: FormProps<IConnection>['uiSchema'];
} {
  const combinedSchema: FormProps<IConnection>['schema'] = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    ...schema,
    properties: {
      name: {
        type: 'string',
        title: 'Connection name',
      },
      group: {
        type: 'string',
        title: 'Connection group',
      },
      driver: { title: 'driver', type: 'string' },
      ...(schema.properties || {}),
      // A driver's own `previewLimit` in its connection.schema.json (e.g. a
      // different default) wins over this fallback — merged, not overwritten,
      // so a driver overriding only `default` still gets `type`/`title` for
      // free. Drivers that declare nothing here keep the historical default.
      previewLimit: {
        default: 50,
        type: 'number',
        title: 'Show records default limit',
        ...(typeof schema.properties?.previewLimit === 'object' ? schema.properties.previewLimit : {}),
      },
    },
    required: ['name', 'driver', ...(schema.required || [])],
  };

  const uiCombinedSchema: FormProps<IConnection>['uiSchema'] = {
    name: { 'ui:autofocus': true },
    driver: { 'ui:widget': 'hidden' },
    ...uiSchema,
    'ui:order': uniq(['name', 'group', ...(uiSchema['ui:order'] || []), '*']),
  };

  return {
    schema: combinedSchema,
    uiSchema: uiCombinedSchema
  }
}