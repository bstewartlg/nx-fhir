import { OperationDefinition } from "fhir/r5";
import { FhirVersion, ServerOperation } from "../../shared/models";
import camelcase from "camelcase";
import { getJavaType } from "../../shared/utils";


export function getClassName(id: string, resourceTypes?: string[]): string {
  return `${camelcase(id, { pascalCase: true })}${!!resourceTypes && resourceTypes.length > 0 ? 'Provider' : 'Operation'}`;
}


export function getEmptyHapiOperation(name: string, targetPackage: string): ServerOperation {
  return {
    id: name,
    url: "",
    name: name,
    code: name.trim().replace(' ', '-').toLowerCase(),
    resource: [],
    system: true,
    type: false,
    instance: false,
    resourceDataTypes: [],
    className: getClassName(name),
    targetPackage: targetPackage,
    methodName: camelcase(name),
    inputParameters: [],
    outputType: undefined
  };
}

/**
 * OperationDefinition.id is optional in FHIR; fall back to the required name.
 * Every place that identifies an operation must use the same fallback, or an
 * id-less operation selected in one place cannot be found in another.
 */
export function getOperationId(
  operationDefinition: OperationDefinition,
): string | undefined {
  return (
    operationDefinition.id ?? operationDefinition.name ?? operationDefinition.code
  );
}

export function getHapiOperation(operationDefinition: OperationDefinition, targetPackage: string, fhirVersion: FhirVersion): ServerOperation {

  const operationId = getOperationId(operationDefinition);
  if (!operationId) {
    throw new Error('OperationDefinition must have an id, name, or code.');
  }
  const className = getClassName(operationId, operationDefinition.resource);

  const operation: ServerOperation = {
    id: operationId,
    url: operationDefinition.url ?? '',
    name: operationDefinition.name,
    code: operationDefinition.code || operationDefinition.name.trim().replace(' ', '-').toLowerCase(),
    resource: operationDefinition.resource ?? [],
    system: operationDefinition.system,
    type: operationDefinition.type,
    instance: operationDefinition.instance,

    resourceDataTypes: operationDefinition.resource?.map(r => getJavaType(r)),
    className: className,
    targetPackage: targetPackage,
    methodName: camelcase(operationId),
    modelPackageVersion: fhirVersion.toLowerCase(),
    inputParameters: (operationDefinition.parameter || [])
                        .filter(p => p.use === 'in')
                        .map(p => {
                          return { 
                            ...p, 
                            dataType: p.type ? getJavaType(p.type) : 'IAnyResource',
                            methodParameterName: `the${camelcase(p.name, { pascalCase: true })}`,
                          }
                        }),
    outputType: (operationDefinition.parameter || [])
                  .filter(p => p.use === 'out')
                  .map(p => {
                    return { 
                      ...p,
                      dataType: p.type ? getJavaType(p.type, true) : 'IAnyResource'
                    }
                  })[0]
  };

  return operation;

}