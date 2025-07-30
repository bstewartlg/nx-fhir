export function getJavaType(fhirType: string, isOutput = false): string {
  if (!fhirType) {
    return "void";
  }

  if (
    fhirType === "base64Binary" ||
    fhirType === "boolean" ||
    fhirType === "canonical" ||
    fhirType === "code" ||
    fhirType === "date" ||
    fhirType === "dateTime" ||
    fhirType === "decimal" ||
    fhirType === "id" ||
    fhirType === "instant" ||
    fhirType === "integer" ||
    fhirType === "inter64" ||
    fhirType === "markdown" ||
    fhirType === "oid" ||
    fhirType === "positiveInt" ||
    fhirType === "string" ||
    fhirType === "time" ||
    fhirType === "unsignedInt" ||
    fhirType === "uri" ||
    fhirType === "url" ||
    fhirType === "uuid"
  ) {
    if (isOutput) {
      return "void";
    }
    return fhirType.charAt(0).toUpperCase() + fhirType.slice(1) + "Type";
  }

  if (fhirType === 'Resource') {
    return 'IAnyResource'
  }
  return fhirType;
}