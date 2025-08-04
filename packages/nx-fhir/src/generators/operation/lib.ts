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
    modelPackageVersion: "r5",
    inputParameters: [],
    outputType: undefined
  };
}

export function getHapiOperation(operationDefinition: OperationDefinition, targetPackage: string, fhirVersion: FhirVersion): ServerOperation {

  const className = getClassName(operationDefinition.id, operationDefinition.resource);

  const operation: ServerOperation = {
    id: operationDefinition.id,
    url: operationDefinition.url,
    name: operationDefinition.name,
    code: operationDefinition.code || operationDefinition.name.trim().replace(' ', '-').toLowerCase(),
    resource: operationDefinition.resource,
    system: operationDefinition.system,
    type: operationDefinition.type,
    instance: operationDefinition.instance,

    resourceDataTypes: operationDefinition.resource?.map(r => getJavaType(r)),
    className: className,
    targetPackage: targetPackage,
    methodName: camelcase(operationDefinition.id),
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
                      dataType: getJavaType(p.type, true)
                    }
                  })[0]
  };

  return operation;

}