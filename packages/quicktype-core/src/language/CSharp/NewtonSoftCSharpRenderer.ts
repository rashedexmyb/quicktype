import { arrayIntercalate } from "collection-utils";

import {
    type ForbiddenWordsInfo,
    inferredNameOrder,
} from "../../ConvenienceRenderer";
import { DependencyName, type Name, SimpleName } from "../../Naming";
import type { RenderContext } from "../../Renderer";
import type { OptionValues } from "../../RendererOptions";
import { type Sourcelike, modifySource } from "../../Source";
import { camelCase, utf16StringEscape } from "../../support/Strings";
import { defined, panic } from "../../support/Support";
import type { TargetLanguage } from "../../TargetLanguage";
import {
    ArrayDecodingTransformer,
    ArrayEncodingTransformer,
    ChoiceTransformer,
    DecodingChoiceTransformer,
    DecodingTransformer,
    EncodingTransformer,
    MinMaxLengthCheckTransformer,
    MinMaxValueTransformer,
    ParseStringTransformer,
    StringMatchTransformer,
    StringProducerTransformer,
    StringifyTransformer,
    type Transformation,
    type Transformer,
    UnionInstantiationTransformer,
    UnionMemberMatchTransformer,
    followTargetType,
    transformationForType,
} from "../../Transformers";
import {
    ArrayType,
    type ClassProperty,
    ClassType,
    EnumType,
    type Type,
    UnionType,
} from "../../Type";
import { nullableFromUnion } from "../../Type/TypeUtils";

import { CSharpRenderer } from "./CSharpRenderer";
import type { newtonsoftCSharpOptions } from "./language";
import {
    AccessModifier,
    alwaysApplyTransformation,
    denseJsonPropertyName,
    denseNullValueHandlingEnumName,
    denseRequiredEnumName,
    isValueType,
    namingFunction,
} from "./utils";

export class NewtonsoftCSharpRenderer extends CSharpRenderer {
    private readonly _enumExtensionsNames = new Map<Name, Name>();

    private readonly _needHelpers: boolean;

    private readonly _needAttributes: boolean;

    private readonly _needNamespaces: boolean;

    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof newtonsoftCSharpOptions>,
    ) {
        super(targetLanguage, renderContext, _options);
        this._needHelpers = _options.features.helpers;
        this._needAttributes = _options.features.attributes;
        this._needNamespaces = _options.features.namespaces;
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        const forbidden = [
            "Converter",
            "JsonConverter",
            "JsonSerializer",
            "JsonWriter",
            "JsonToken",
            "Serialize",
            "Newtonsoft",
            "MetadataPropertyHandling",
            "DateParseHandling",
            "FromJson",
            "Required",
        ];
        if (this._options.dense) {
            forbidden.push("J", "R", "N");
        }

        if (this._options.baseclass !== undefined) {
            forbidden.push(this._options.baseclass);
        }

        return super.forbiddenNamesForGlobalNamespace().concat(forbidden);
    }

    protected forbiddenForObjectProperties(
        c: ClassType,
        className: Name,
    ): ForbiddenWordsInfo {
        const result = super.forbiddenForObjectProperties(c, className);
        result.names = result.names.concat(["ToJson", "FromJson", "Required"]);
        return result;
    }

    protected makeNameForTransformation(
        xf: Transformation,
        typeName: Name | undefined,
    ): Name {
        if (typeName === undefined) {
            let xfer = xf.transformer;
            if (
                xfer instanceof DecodingTransformer &&
                xfer.consumer !== undefined
            ) {
                xfer = xfer.consumer;
            }

            return new SimpleName(
                [`${xfer.kind}_converter`],
                namingFunction,
                inferredNameOrder + 30,
            );
        }

        return new DependencyName(
            namingFunction,
            typeName.order + 30,
            (lookup) => `${lookup(typeName)}_converter`,
        );
    }

    protected makeNamedTypeDependencyNames(
        t: Type,
        name: Name,
    ): DependencyName[] {
        if (!(t instanceof EnumType)) return [];

        const extensionsName = new DependencyName(
            namingFunction,
            name.order + 30,
            (lookup) => `${lookup(name)}_extensions`,
        );
        this._enumExtensionsNames.set(name, extensionsName);
        return [extensionsName];
    }

    protected emitUsings(): void {
        if (!this._needAttributes && !this._needHelpers) {
            this.emitDependencyUsings();
            return;
        }

        super.emitUsings();
        this.ensureBlankLine();

        for (const ns of [
            "System.Globalization",
            "Newtonsoft.Json",
            "Newtonsoft.Json.Converters",
        ]) {
            this.emitUsing(ns);
        }

        if (this._options.dense) {
            this.emitUsing([
                denseJsonPropertyName,
                " = Newtonsoft.Json.JsonPropertyAttribute",
            ]);
            this.emitUsing([
                denseRequiredEnumName,
                " = Newtonsoft.Json.Required",
            ]);
            this.emitUsing([
                denseNullValueHandlingEnumName,
                " = Newtonsoft.Json.NullValueHandling",
            ]);
        }

        if (this._options.baseclass === "EntityData") {
            this.emitUsing("Microsoft.Azure.Mobile.Server");
        }
    }

    protected baseclassForType(_t: Type): Sourcelike | undefined {
        return this._options.baseclass;
    }

    protected emitDefaultLeadingComments(): void {
        if (!this._needHelpers) return;

        this.emitLine("// <auto-generated />");
        this.emitLine("//");
        this.emitLine(
            "// To parse this JSON data, add NuGet 'Newtonsoft.Json' then do",
            this.topLevels.size === 1 ? "" : " one of these",
            ":",
        );
        this.emitLine("//");
        this.emitLine("//    using ", this._options.namespace, ";");
        this.emitLine("//");
        this.forEachTopLevel("none", (t, topLevelName) => {
            let rhs: Sourcelike;
            if (t instanceof EnumType) {
                rhs = [
                    "JsonConvert.DeserializeObject<",
                    topLevelName,
                    ">(jsonString)",
                ];
            } else {
                rhs = [topLevelName, ".FromJson(jsonString)"];
            }

            this.emitLine(
                "//    var ",
                modifySource(camelCase, topLevelName),
                " = ",
                rhs,
                ";",
            );
        });
    }

    private converterForType(t: Type): Name | undefined {
        let xf = transformationForType(t);

        if (xf === undefined && t instanceof UnionType) {
            const maybeNullable = nullableFromUnion(t);
            if (maybeNullable !== null) {
                t = maybeNullable;
                xf = transformationForType(t);
            }
        }

        if (xf === undefined) return undefined;

        if (alwaysApplyTransformation(xf)) return undefined;

        return defined(this.nameForTransformation(t));
    }

    protected attributesForProperty(
        property: ClassProperty,
        _name: Name,
        _c: ClassType,
        jsonName: string,
    ): Sourcelike[] | undefined {
        if (!this._needAttributes) return undefined;

        const attributes: Sourcelike[] = [];

        const jsonProperty = this._options.dense
            ? denseJsonPropertyName
            : "JsonProperty";
        const escapedName = utf16StringEscape(jsonName);
        const isNullable = followTargetType(property.type).isNullable;
        const isOptional = property.isOptional;
        const requiredClass = this._options.dense ? "R" : "Required";
        const nullValueHandlingClass = this._options.dense
            ? "N"
            : "NullValueHandling";
        const nullValueHandling =
            isOptional && !isNullable
                ? [", NullValueHandling = ", nullValueHandlingClass, ".Ignore"]
                : [];
        let required: Sourcelike;
        if (!this._options.checkRequired || (isOptional && isNullable)) {
            required = [nullValueHandling];
        } else if (isOptional && !isNullable) {
            required = [
                ", Required = ",
                requiredClass,
                ".DisallowNull",
                nullValueHandling,
            ];
        } else if (!isOptional && isNullable) {
            required = [", Required = ", requiredClass, ".AllowNull"];
        } else {
            required = [
                ", Required = ",
                requiredClass,
                ".Always",
                nullValueHandling,
            ];
        }

        attributes.push([
            "[",
            jsonProperty,
            '("',
            escapedName,
            '"',
            required,
            ")]",
        ]);

        const converter = this.converterForType(property.type);
        if (converter !== undefined) {
            attributes.push(["[JsonConverter(typeof(", converter, "))]"]);
        }

        return attributes;
    }

    protected blankLinesBetweenAttributes(): boolean {
        return this._needAttributes && !this._options.dense;
    }

    // The "this" type can't be `dynamic`, so we have to force it to `object`.
    private topLevelResultType(t: Type): Sourcelike {
        return t.kind === "any" || t.kind === "none"
            ? "object"
            : this.csType(t);
    }

    private emitFromJsonForTopLevel(t: Type, name: Name): void {
        if (t instanceof EnumType) return;

        let partial: string;
        let typeKind: string;
        const definedType = this.namedTypeToNameForTopLevel(t);
        if (definedType !== undefined) {
            partial = "partial ";
            typeKind = definedType instanceof ClassType ? "class" : "struct";
        } else {
            partial = "";
            typeKind = "class";
        }

        const csType = this.topLevelResultType(t);
        this.emitType(
            undefined,
            AccessModifier.Public,
            [partial, typeKind],
            name,
            this.baseclassForType(t),
            () => {
                // FIXME: Make FromJson a Named
                this.emitExpressionMember(
                    ["public static ", csType, " FromJson(string json)"],
                    [
                        "JsonConvert.DeserializeObject<",
                        csType,
                        ">(json, ",
                        this._options.namespace,
                        ".Converter.Settings)",
                    ],
                );
            },
        );
    }

    private emitDecoderSwitch(emitBody: () => void): void {
        this.emitLine("switch (reader.TokenType)");
        this.emitBlock(emitBody);
    }

    private emitTokenCase(tokenType: string): void {
        this.emitLine("case JsonToken.", tokenType, ":");
    }

    private emitThrow(message: Sourcelike): void {
        this.emitLine("throw new Exception(", message, ");");
    }

    private deserializeTypeCode(typeName: Sourcelike): Sourcelike {
        return ["serializer.Deserialize<", typeName, ">(reader)"];
    }

    private serializeValueCode(value: Sourcelike): Sourcelike {
        return ["serializer.Serialize(writer, ", value, ")"];
    }

    private emitSerializeClass(): void {
        // FIXME: Make Serialize a Named
        this.emitType(
            undefined,
            AccessModifier.Public,
            "static class",
            "Serialize",
            undefined,
            () => {
                // Sometimes multiple top-levels will resolve to the same type, so we have to take care
                // not to emit more than one extension method for the same type.
                const seenTypes = new Set<Type>();
                this.forEachTopLevel("none", (t) => {
                    // FIXME: Make ToJson a Named
                    if (!seenTypes.has(t)) {
                        seenTypes.add(t);
                        this.emitExpressionMember(
                            [
                                "public static string ToJson(this ",
                                this.topLevelResultType(t),
                                " self)",
                            ],
                            [
                                "JsonConvert.SerializeObject(self, ",
                                this._options.namespace,
                                ".Converter.Settings)",
                            ],
                        );
                    }
                });
            },
        );
    }

    private emitCanConvert(expr: Sourcelike): void {
        this.emitExpressionMember(
            "public override bool CanConvert(Type t)",
            expr,
        );
    }

    private emitReadJson(emitBody: () => void): void {
        this.emitLine(
            "public override object ReadJson(JsonReader reader, Type t, object existingValue, JsonSerializer serializer)",
        );
        this.emitBlock(emitBody);
    }

    private emitWriteJson(variable: string, emitBody: () => void): void {
        this.emitLine(
            "public override void WriteJson(JsonWriter writer, object ",
            variable,
            ", JsonSerializer serializer)",
        );
        this.emitBlock(emitBody);
    }

    private converterObject(converterName: Name): Sourcelike {
        // FIXME: Get a singleton
        return [converterName, ".Singleton"];
    }

    private emitConverterClass(): void {
        // FIXME: Make Converter a Named
        const converterName: Sourcelike = ["Converter"];
        this.emitType(
            undefined,
            AccessModifier.Internal,
            "static class",
            converterName,
            undefined,
            () => {
                this.emitLine(
                    "public static readonly JsonSerializerSettings Settings = new JsonSerializerSettings",
                );
                this.emitBlock(() => {
                    this.emitLine(
                        "MetadataPropertyHandling = MetadataPropertyHandling.Ignore,",
                    );
                    this.emitLine(
                        "DateParseHandling = DateParseHandling.None,",
                    );
                    this.emitLine("Converters =");
                    this.emitLine("{");
                    this.indent(() => {
                        for (const [t, converter] of this
                            .typesWithNamedTransformations) {
                            if (
                                alwaysApplyTransformation(
                                    defined(transformationForType(t)),
                                )
                            ) {
                                this.emitLine(
                                    this.converterObject(converter),
                                    ",",
                                );
                            }
                        }

                        this.emitLine(
                            "new IsoDateTimeConverter { DateTimeStyles = DateTimeStyles.AssumeUniversal }",
                        );
                    });
                    this.emitLine("},");
                }, true);
            },
        );
    }

    private emitDecoderTransformerCase(
        tokenCases: string[],
        variableName: string,
        xfer: Transformer | undefined,
        targetType: Type,
        emitFinish: (value: Sourcelike) => void,
    ): void {
        if (xfer === undefined) return;

        for (const tokenCase of tokenCases) {
            this.emitTokenCase(tokenCase);
        }

        this.indent(() => {
            const allHandled = this.emitDecodeTransformer(
                xfer,
                targetType,
                emitFinish,
                variableName,
            );
            if (!allHandled) {
                this.emitLine("break;");
            }
        });
    }

    private emitConsume(
        value: Sourcelike,
        consumer: Transformer | undefined,
        targetType: Type,
        emitFinish: (variableName: Sourcelike) => void,
    ): boolean {
        if (consumer === undefined) {
            emitFinish(value);
            return true;
        }

        return this.emitTransformer(value, consumer, targetType, emitFinish);
    }

    private emitDecodeTransformer(
        xfer: Transformer,
        targetType: Type,
        emitFinish: (value: Sourcelike) => void,
        variableName = "value",
    ): boolean {
        if (xfer instanceof DecodingTransformer) {
            const source = xfer.sourceType;
            const converter = this.converterForType(targetType);
            if (converter !== undefined) {
                const typeSource = this.csType(targetType);
                this.emitLine(
                    "var converter = ",
                    this.converterObject(converter),
                    ";",
                );
                this.emitLine(
                    "var ",
                    variableName,
                    " = (",
                    typeSource,
                    ")converter.ReadJson(reader, typeof(",
                    typeSource,
                    "), null, serializer);",
                );
            } else if (source.kind !== "null") {
                const output =
                    targetType.kind === "double" ? targetType : source;
                this.emitLine(
                    "var ",
                    variableName,
                    " = ",
                    this.deserializeTypeCode(this.csType(output)),
                    ";",
                );
            }

            return this.emitConsume(
                variableName,
                xfer.consumer,
                targetType,
                emitFinish,
            );
        }

        if (xfer instanceof ArrayDecodingTransformer) {
            // FIXME: Consume StartArray
            if (!(targetType instanceof ArrayType)) {
                return panic("Array decoding must produce an array type");
            }

            // FIXME: handle EOF
            this.emitLine("reader.Read();");
            this.emitLine(
                "var ",
                variableName,
                " = new List<",
                this.csType(targetType.items),
                ">();",
            );
            this.emitLine("while (reader.TokenType != JsonToken.EndArray)");
            this.emitBlock(() => {
                this.emitDecodeTransformer(
                    xfer.itemTransformer,
                    xfer.itemTargetType,
                    (v) => this.emitLine(variableName, ".Add(", v, ");"),
                    "arrayItem",
                );
                // FIXME: handle EOF
                this.emitLine("reader.Read();");
            });
            let result: Sourcelike = variableName;
            if (!this._options.useList) {
                result = [result, ".ToArray()"];
            }

            emitFinish(result);
            return true;
        }

        if (xfer instanceof DecodingChoiceTransformer) {
            this.emitDecoderSwitch(() => {
                const nullTransformer = xfer.nullTransformer;
                if (nullTransformer !== undefined) {
                    this.emitTokenCase("Null");
                    this.indent(() => {
                        const allHandled = this.emitDecodeTransformer(
                            nullTransformer,
                            targetType,
                            emitFinish,
                            "null",
                        );
                        if (!allHandled) {
                            this.emitLine("break");
                        }
                    });
                }

                this.emitDecoderTransformerCase(
                    ["Integer"],
                    "integerValue",
                    xfer.integerTransformer,
                    targetType,
                    emitFinish,
                );
                this.emitDecoderTransformerCase(
                    xfer.integerTransformer === undefined
                        ? ["Integer", "Float"]
                        : ["Float"],
                    "doubleValue",
                    xfer.doubleTransformer,
                    targetType,
                    emitFinish,
                );
                this.emitDecoderTransformerCase(
                    ["Boolean"],
                    "boolValue",
                    xfer.boolTransformer,
                    targetType,
                    emitFinish,
                );
                this.emitDecoderTransformerCase(
                    ["String", "Date"],
                    "stringValue",
                    xfer.stringTransformer,
                    targetType,
                    emitFinish,
                );
                this.emitDecoderTransformerCase(
                    ["StartObject"],
                    "objectValue",
                    xfer.objectTransformer,
                    targetType,
                    emitFinish,
                );
                this.emitDecoderTransformerCase(
                    ["StartArray"],
                    "arrayValue",
                    xfer.arrayTransformer,
                    targetType,
                    emitFinish,
                );
            });
            return false;
        }

        return panic("Unknown transformer");
    }

    private stringCaseValue(t: Type, stringCase: string): Sourcelike {
        if (t.kind === "string") {
            return ['"', utf16StringEscape(stringCase), '"'];
        }
        if (t instanceof EnumType) {
            return [
                this.nameForNamedType(t),
                ".",
                this.nameForEnumCase(t, stringCase),
            ];
        }

        return panic(`Type ${t.kind} does not have string cases`);
    }

    private emitTransformer(
        variable: Sourcelike,
        xfer: Transformer,
        targetType: Type,
        emitFinish: (value: Sourcelike) => void,
    ): boolean {
        function directTargetType(continuation: Transformer | undefined): Type {
            if (continuation === undefined) {
                return targetType;
            }

            return followTargetType(continuation.sourceType);
        }

        if (xfer instanceof ChoiceTransformer) {
            const caseXfers = xfer.transformers;
            if (
                caseXfers.length > 1 &&
                caseXfers.every(
                    (caseXfer) => caseXfer instanceof StringMatchTransformer,
                )
            ) {
                this.emitLine("switch (", variable, ")");
                this.emitBlock(() => {
                    for (const caseXfer of caseXfers) {
                        const matchXfer = caseXfer as StringMatchTransformer;
                        const value = this.stringCaseValue(
                            followTargetType(matchXfer.sourceType),
                            matchXfer.stringCase,
                        );
                        this.emitLine("case ", value, ":");
                        this.indent(() => {
                            const allDone = this.emitTransformer(
                                variable,
                                matchXfer.transformer,
                                targetType,
                                emitFinish,
                            );
                            if (!allDone) {
                                this.emitLine("break;");
                            }
                        });
                    }
                });
                // FIXME: Can we check for exhaustiveness?  For enums it should be easy.
                return false;
            }

            for (const caseXfer of caseXfers) {
                this.emitTransformer(
                    variable,
                    caseXfer,
                    targetType,
                    emitFinish,
                );
            }
        } else if (xfer instanceof UnionMemberMatchTransformer) {
            const memberType = xfer.memberType;
            const maybeNullable = nullableFromUnion(xfer.sourceType);
            let test: Sourcelike;
            let member: Sourcelike;
            if (maybeNullable !== null) {
                if (memberType.kind === "null") {
                    test = [variable, " == null"];
                    member = "null";
                } else {
                    test = [variable, " != null"];
                    member = variable;
                }
            } else if (memberType.kind === "null") {
                test = [variable, ".IsNull"];
                member = "null";
            } else {
                const memberName = this.nameForUnionMember(
                    xfer.sourceType,
                    memberType,
                );
                member = [variable, ".", memberName];
                test = [member, " != null"];
            }

            if (memberType.kind !== "null" && isValueType(memberType)) {
                member = [member, ".Value"];
            }

            this.emitLine("if (", test, ")");
            this.emitBlock(() =>
                this.emitTransformer(
                    member,
                    xfer.transformer,
                    targetType,
                    emitFinish,
                ),
            );
        } else if (xfer instanceof StringMatchTransformer) {
            const value = this.stringCaseValue(
                followTargetType(xfer.sourceType),
                xfer.stringCase,
            );
            this.emitLine("if (", variable, " == ", value, ")");
            this.emitBlock(() =>
                this.emitTransformer(
                    variable,
                    xfer.transformer,
                    targetType,
                    emitFinish,
                ),
            );
        } else if (xfer instanceof EncodingTransformer) {
            const converter = this.converterForType(xfer.sourceType);
            if (converter !== undefined) {
                this.emitLine(
                    "var converter = ",
                    this.converterObject(converter),
                    ";",
                );
                this.emitLine(
                    "converter.WriteJson(writer, ",
                    variable,
                    ", serializer);",
                );
            } else {
                this.emitLine(this.serializeValueCode(variable), ";");
            }

            emitFinish([]);
            return true;
        } else if (xfer instanceof ArrayEncodingTransformer) {
            this.emitLine("writer.WriteStartArray();");
            const itemVariable = "arrayItem";
            this.emitLine("foreach (var ", itemVariable, " in ", variable, ")");
            this.emitBlock(() => {
                this.emitTransformer(
                    itemVariable,
                    xfer.itemTransformer,
                    xfer.itemTargetType,
                    () => {
                        return;
                    },
                );
            });
            this.emitLine("writer.WriteEndArray();");
            emitFinish([]);
            return true;
        } else if (xfer instanceof ParseStringTransformer) {
            const immediateTargetType =
                xfer.consumer === undefined
                    ? targetType
                    : xfer.consumer.sourceType;
            switch (immediateTargetType.kind) {
                case "date-time":
                    this.emitLine("DateTimeOffset dt;");
                    this.emitLine(
                        "if (DateTimeOffset.TryParse(",
                        variable,
                        ", out dt))",
                    );
                    this.emitBlock(() =>
                        this.emitConsume(
                            "dt",
                            xfer.consumer,
                            targetType,
                            emitFinish,
                        ),
                    );
                    break;
                case "uuid":
                    this.emitLine("Guid guid;");
                    this.emitLine(
                        "if (Guid.TryParse(",
                        variable,
                        ", out guid))",
                    );
                    this.emitBlock(() =>
                        this.emitConsume(
                            "guid",
                            xfer.consumer,
                            targetType,
                            emitFinish,
                        ),
                    );
                    break;
                case "uri":
                    this.emitLine("try");
                    this.emitBlock(() => {
                        this.emitLine("var uri = new Uri(", variable, ");");
                        this.emitConsume(
                            "uri",
                            xfer.consumer,
                            targetType,
                            emitFinish,
                        );
                    });
                    this.emitLine("catch (UriFormatException) {}");
                    break;
                case "integer":
                    this.emitLine("long l;");
                    this.emitLine("if (Int64.TryParse(", variable, ", out l))");
                    this.emitBlock(() =>
                        this.emitConsume(
                            "l",
                            xfer.consumer,
                            targetType,
                            emitFinish,
                        ),
                    );
                    break;
                case "bool":
                    this.emitLine("bool b;");
                    this.emitLine(
                        "if (Boolean.TryParse(",
                        variable,
                        ", out b))",
                    );
                    this.emitBlock(() =>
                        this.emitConsume(
                            "b",
                            xfer.consumer,
                            targetType,
                            emitFinish,
                        ),
                    );
                    break;
                default:
                    return panic(
                        `Parsing string to ${immediateTargetType.kind} not supported`,
                    );
            }
        } else if (xfer instanceof StringifyTransformer) {
            switch (xfer.sourceType.kind) {
                case "date-time":
                    return this.emitConsume(
                        [
                            variable,
                            '.ToString("o", System.Globalization.CultureInfo.InvariantCulture)',
                        ],
                        xfer.consumer,
                        targetType,
                        emitFinish,
                    );
                case "uuid":
                    return this.emitConsume(
                        [
                            variable,
                            '.ToString("D", System.Globalization.CultureInfo.InvariantCulture)',
                        ],
                        xfer.consumer,
                        targetType,
                        emitFinish,
                    );
                case "integer":
                case "uri":
                    return this.emitConsume(
                        [variable, ".ToString()"],
                        xfer.consumer,
                        targetType,
                        emitFinish,
                    );
                case "bool":
                    this.emitLine(
                        "var boolString = ",
                        variable,
                        ' ? "true" : "false";',
                    );
                    return this.emitConsume(
                        "boolString",
                        xfer.consumer,
                        targetType,
                        emitFinish,
                    );
                default:
                    return panic(
                        `Stringifying ${xfer.sourceType.kind} not supported`,
                    );
            }
        } else if (xfer instanceof StringProducerTransformer) {
            const value = this.stringCaseValue(
                directTargetType(xfer.consumer),
                xfer.result,
            );
            return this.emitConsume(
                value,
                xfer.consumer,
                targetType,
                emitFinish,
            );
        } else if (xfer instanceof MinMaxLengthCheckTransformer) {
            const min = xfer.minLength;
            const max = xfer.maxLength;
            const conditions: Sourcelike[] = [];

            if (min !== undefined) {
                conditions.push([variable, ".Length >= ", min.toString()]);
            }

            if (max !== undefined) {
                conditions.push([variable, ".Length <= ", max.toString()]);
            }

            this.emitLine("if (", arrayIntercalate([" && "], conditions), ")");
            this.emitBlock(() =>
                this.emitConsume(
                    variable,
                    xfer.consumer,
                    targetType,
                    emitFinish,
                ),
            );
            return false;
        } else if (xfer instanceof MinMaxValueTransformer) {
            const min = xfer.minimum;
            const max = xfer.maximum;
            const conditions: Sourcelike[] = [];

            if (min !== undefined) {
                conditions.push([variable, " >= ", min.toString()]);
            }

            if (max !== undefined) {
                conditions.push([variable, " <= ", max.toString()]);
            }

            this.emitLine("if (", arrayIntercalate([" && "], conditions), ")");
            this.emitBlock(() =>
                this.emitConsume(
                    variable,
                    xfer.consumer,
                    targetType,
                    emitFinish,
                ),
            );
            return false;
        } else if (xfer instanceof UnionInstantiationTransformer) {
            if (!(targetType instanceof UnionType)) {
                return panic(
                    "Union instantiation transformer must produce a union type",
                );
            }

            const maybeNullable = nullableFromUnion(targetType);
            if (maybeNullable !== null) {
                emitFinish(variable);
            } else {
                const unionName = this.nameForNamedType(targetType);
                let initializer: Sourcelike;
                if (xfer.sourceType.kind === "null") {
                    initializer = " ";
                } else {
                    const memberName = this.nameForUnionMember(
                        targetType,
                        xfer.sourceType,
                    );
                    initializer = [" ", memberName, " = ", variable, " "];
                }

                emitFinish(["new ", unionName, " {", initializer, "}"]);
            }

            return true;
        } else {
            return panic("Unknown transformer");
        }

        return false;
    }

    private emitTransformation(converterName: Name, t: Type): void {
        const xf = defined(transformationForType(t));
        const reverse = xf.reverse;
        const targetType = xf.targetType;
        const xfer = xf.transformer;
        this.emitType(
            undefined,
            AccessModifier.Internal,
            "class",
            converterName,
            "JsonConverter",
            () => {
                const csType = this.csType(targetType);
                let canConvertExpr: Sourcelike = ["t == typeof(", csType, ")"];
                const haveNullable = isValueType(targetType);
                if (haveNullable) {
                    canConvertExpr = [
                        canConvertExpr,
                        " || t == typeof(",
                        csType,
                        "?)",
                    ];
                }

                this.emitCanConvert(canConvertExpr);
                this.ensureBlankLine();
                this.emitReadJson(() => {
                    // FIXME: It's unsatisfying that we need this.  The reason is that we not
                    // only match T, but also T?.  If we didn't, then the T in T? would not be
                    // deserialized with our converter but with the default one.  Can we check
                    // whether the type is a nullable?
                    // FIXME: This could duplicate one of the cases handled below in
                    // `emitDecodeTransformer`.
                    if (haveNullable && !(targetType instanceof UnionType)) {
                        this.emitLine(
                            "if (reader.TokenType == JsonToken.Null) return null;",
                        );
                    }

                    const allHandled = this.emitDecodeTransformer(
                        xfer,
                        targetType,
                        (v) => this.emitLine("return ", v, ";"),
                    );
                    if (!allHandled) {
                        this.emitThrow([
                            '"Cannot unmarshal type ',
                            csType,
                            '"',
                        ]);
                    }
                });
                this.ensureBlankLine();
                this.emitWriteJson("untypedValue", () => {
                    // FIXME: See above.
                    if (haveNullable && !(targetType instanceof UnionType)) {
                        this.emitLine("if (untypedValue == null)");
                        this.emitBlock(() => {
                            this.emitLine(
                                "serializer.Serialize(writer, null);",
                            );
                            this.emitLine("return;");
                        });
                    }

                    this.emitLine("var value = (", csType, ")untypedValue;");
                    const allHandled = this.emitTransformer(
                        "value",
                        reverse.transformer,
                        reverse.targetType,
                        () => this.emitLine("return;"),
                    );
                    if (!allHandled) {
                        this.emitThrow(['"Cannot marshal type ', csType, '"']);
                    }
                });
                this.ensureBlankLine();
                this.emitLine(
                    "public static readonly ",
                    converterName,
                    " Singleton = new ",
                    converterName,
                    "();",
                );
            },
        );
    }

    protected emitRequiredHelpers(): void {
        if (this._needHelpers) {
            this.forEachTopLevel("leading-and-interposing", (t, n) =>
                this.emitFromJsonForTopLevel(t, n),
            );
            this.ensureBlankLine();
            this.emitSerializeClass();
        }

        if (
            this._needHelpers ||
            (this._needAttributes && (this.haveNamedUnions || this.haveEnums))
        ) {
            this.ensureBlankLine();
            this.emitConverterClass();
            this.forEachTransformation("leading-and-interposing", (n, t) =>
                this.emitTransformation(n, t),
            );
        }
    }

    protected needNamespace(): boolean {
        return this._needNamespaces;
    }
}
