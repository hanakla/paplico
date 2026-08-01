import { CstParser } from "chevrotain";
import * as t from "./tokens";

/**
 * CST parser for Syrup. Trailing closures are disallowed while parsing
 * `if`/`while`/`for`/`switch` headers (tracked by `condDepth`), and re-allowed
 * inside any parenthesized/bracketed sub-expression.
 */
export class SyrupParser extends CstParser {
	private condDepth = 0;

	public constructor() {
		super(t.allTokens, {
			recoveryEnabled: true,
			nodeLocationTracking: "full",
			maxLookahead: 3,
		});
		this.performSelfAnalysis();
	}

	public program = this.RULE("program", () => {
		this.MANY(() => this.SUBRULE(this.statement));
	});

	public statement = this.RULE("statement", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.bindingDecl) },
			{ ALT: () => this.SUBRULE(this.funcDecl) },
			{ ALT: () => this.SUBRULE(this.structDecl) },
			{ ALT: () => this.SUBRULE(this.enumDecl) },
			{ ALT: () => this.SUBRULE(this.classDecl) },
			{ ALT: () => this.SUBRULE(this.protocolDecl) },
			{ ALT: () => this.SUBRULE(this.exportedDecl) },
			{ ALT: () => this.SUBRULE(this.useStmt) },
			{ ALT: () => this.SUBRULE(this.declareDecl) },
			{ ALT: () => this.SUBRULE(this.ifStmt) },
			{ ALT: () => this.SUBRULE(this.guardStmt) },
			{ ALT: () => this.SUBRULE(this.forStmt) },
			{ ALT: () => this.SUBRULE(this.whileStmt) },
			{ ALT: () => this.SUBRULE(this.switchStmt) },
			{ ALT: () => this.SUBRULE(this.returnStmt) },
			{ ALT: () => this.SUBRULE(this.throwStmt) },
			{ ALT: () => this.SUBRULE(this.doCatchStmt) },
			{ ALT: () => this.CONSUME(t.Break) },
			{ ALT: () => this.CONSUME(t.Continue) },
			{ ALT: () => this.CONSUME(t.Semicolon) },
			{
				// Statement-position `do` is always the do-catch statement.
				GATE: () => this.LA(1).tokenType !== t.Do,
				ALT: () => this.SUBRULE(this.exprStatement),
			},
		]);
	});

	private exportedDecl = this.RULE("exportedDecl", () => {
		this.CONSUME(t.Export);
		this.OR([
			{ ALT: () => this.SUBRULE(this.bindingDecl) },
			{ ALT: () => this.SUBRULE(this.funcDecl) },
			{ ALT: () => this.SUBRULE(this.structDecl) },
			{ ALT: () => this.SUBRULE(this.enumDecl) },
			{ ALT: () => this.SUBRULE(this.classDecl) },
			{ ALT: () => this.SUBRULE(this.protocolDecl) },
		]);
	});

	private useStmt = this.RULE("useStmt", () => {
		this.CONSUME(t.Use);
		this.OR([
			{
				ALT: () => {
					this.CONSUME(t.LCurly);
					// Empty lists parse (editor-friendly); the checker rejects them.
					this.MANY_SEP({
						SEP: t.Comma,
						DEF: () => this.CONSUME(t.Identifier),
					});
					this.CONSUME(t.RCurly);
				},
			},
			{ ALT: () => this.CONSUME2(t.Identifier) },
		]);
		this.CONSUME(t.From);
		this.CONSUME(t.StringLiteral);
	});

	private bindingDecl = this.RULE("bindingDecl", () => {
		this.OR([
			{ ALT: () => this.CONSUME(t.Let) },
			{ ALT: () => this.CONSUME(t.Var) },
		]);
		this.CONSUME(t.Identifier);
		this.OPTION(() => {
			this.CONSUME(t.Colon);
			this.SUBRULE(this.typeRef);
		});
		this.CONSUME(t.Equals);
		this.SUBRULE(this.expression);
	});

	private funcDecl = this.RULE("funcDecl", () => {
		this.MANY(() => this.SUBRULE(this.attribute));
		this.OPTION4(() => this.CONSUME(t.Async));
		this.CONSUME(t.Fn);
		this.CONSUME(t.Identifier);
		this.OPTION(() => this.SUBRULE(this.genericParams));
		this.CONSUME(t.LParen);
		this.OPTION2(() => this.SUBRULE(this.paramList));
		this.CONSUME(t.RParen);
		this.OPTION5(() => this.CONSUME(t.Throws));
		this.OPTION3(() => {
			this.CONSUME(t.Arrow);
			this.SUBRULE(this.typeRef);
		});
		this.SUBRULE(this.block);
	});

	/** `@name` declaration attribute (e.g. `@test`). */
	private attribute = this.RULE("attribute", () => {
		this.CONSUME(t.At);
		this.CONSUME(t.Identifier);
	});

	private genericParams = this.RULE("genericParams", () => {
		this.CONSUME(t.Less);
		this.SUBRULE(this.genericParam);
		this.MANY(() => {
			this.CONSUME(t.Comma);
			this.SUBRULE2(this.genericParam);
		});
		this.CONSUME(t.Greater);
	});

	/** `T` or `T: Constraint` (upper bound, class or protocol). */
	private genericParam = this.RULE("genericParam", () => {
		this.CONSUME(t.Identifier);
		this.OPTION(() => {
			this.CONSUME(t.Colon);
			this.SUBRULE(this.typeRef);
		});
	});

	private paramList = this.RULE("paramList", () => {
		this.SUBRULE(this.param);
		this.MANY(() => {
			this.CONSUME(t.Comma);
			this.SUBRULE2(this.param);
		});
	});

	private param = this.RULE("param", () => {
		// External labels may be keywords (`fn move(from start: Number)`).
		this.OR([
			{ ALT: () => this.CONSUME(t.Identifier, { LABEL: "first" }) },
			{ ALT: () => this.CONSUME(t.From, { LABEL: "first" }) },
			{ ALT: () => this.CONSUME(t.Use, { LABEL: "first" }) },
		]);
		this.OPTION(() => this.CONSUME2(t.Identifier, { LABEL: "second" }));
		this.OPTION3(() => this.CONSUME(t.Question, { LABEL: "omittable" }));
		this.CONSUME(t.Colon);
		this.SUBRULE(this.typeRef);
		this.OPTION2(() => {
			this.CONSUME(t.Equals);
			this.SUBRULE(this.expression);
		});
	});

	private structDecl = this.RULE("structDecl", () => {
		this.CONSUME(t.Struct);
		this.CONSUME(t.Identifier);
		this.OPTION(() => this.SUBRULE(this.genericParams));
		this.CONSUME(t.LCurly);
		this.MANY(() => {
			this.OR([
				{ ALT: () => this.SUBRULE(this.fieldDecl) },
				{ ALT: () => this.SUBRULE(this.methodDecl) },
			]);
		});
		this.CONSUME(t.RCurly);
	});

	private fieldDecl = this.RULE("fieldDecl", () => {
		this.OR([
			{ ALT: () => this.CONSUME(t.Let) },
			{ ALT: () => this.CONSUME(t.Var) },
		]);
		this.CONSUME(t.Identifier);
		this.CONSUME(t.Colon);
		this.SUBRULE(this.typeRef);
		this.OPTION2(() => {
			this.CONSUME(t.Equals);
			this.SUBRULE(this.expression);
		});
		this.OPTION(() => this.CONSUME(t.Semicolon));
	});

	/** `override fn` / `mutating fn` / `async fn` method with a body. */
	private methodDecl = this.RULE("methodDecl", () => {
		this.OPTION(() => this.CONSUME(t.Identifier, { LABEL: "modifier" }));
		this.SUBRULE(this.funcDecl);
	});

	private enumDecl = this.RULE("enumDecl", () => {
		this.CONSUME(t.Enum);
		this.CONSUME(t.Identifier);
		this.OPTION(() => this.SUBRULE(this.genericParams));
		this.CONSUME(t.LCurly);
		this.MANY(() => {
			this.OR([
				{ ALT: () => this.SUBRULE(this.enumCaseDecl) },
				{ ALT: () => this.SUBRULE(this.methodDecl) },
			]);
		});
		this.CONSUME(t.RCurly);
	});

	private classDecl = this.RULE("classDecl", () => {
		this.CONSUME(t.Class);
		this.CONSUME(t.Identifier);
		this.OPTION(() => this.SUBRULE(this.genericParams));
		this.OPTION2(() => {
			this.CONSUME(t.Colon);
			this.SUBRULE(this.typeRef, { LABEL: "heritage" });
			this.MANY(() => {
				this.CONSUME(t.Comma);
				this.SUBRULE2(this.typeRef, { LABEL: "heritage" });
			});
		});
		this.CONSUME(t.LCurly);
		this.MANY2(() => {
			this.OR([
				{ ALT: () => this.SUBRULE(this.fieldDecl) },
				{ ALT: () => this.SUBRULE(this.initDecl) },
				{ ALT: () => this.SUBRULE(this.methodDecl) },
			]);
		});
		this.CONSUME(t.RCurly);
	});

	private initDecl = this.RULE("initDecl", () => {
		this.CONSUME(t.Identifier, { LABEL: "initKeyword" });
		this.CONSUME(t.LParen);
		this.OPTION(() => this.SUBRULE(this.paramList));
		this.CONSUME(t.RParen);
		this.SUBRULE(this.block);
	});

	private protocolDecl = this.RULE("protocolDecl", () => {
		this.CONSUME(t.Protocol);
		this.CONSUME(t.Identifier);
		this.OPTION(() => this.SUBRULE(this.genericParams));
		this.CONSUME(t.LCurly);
		this.MANY(() => {
			this.OR([
				{ ALT: () => this.SUBRULE(this.fieldDecl) },
				{ ALT: () => this.SUBRULE(this.declareFunc) },
			]);
			this.OPTION2(() => this.CONSUME(t.Semicolon));
		});
		this.CONSUME(t.RCurly);
	});

	private enumCaseDecl = this.RULE("enumCaseDecl", () => {
		this.CONSUME(t.Case);
		this.CONSUME(t.Identifier);
		this.OPTION(() => {
			this.CONSUME(t.LParen);
			this.SUBRULE(this.assocParam);
			this.MANY(() => {
				this.CONSUME(t.Comma);
				this.SUBRULE2(this.assocParam);
			});
			this.CONSUME(t.RParen);
		});
		this.OPTION2(() => this.CONSUME(t.Semicolon));
	});

	private assocParam = this.RULE("assocParam", () => {
		this.CONSUME(t.Identifier);
		this.CONSUME(t.Colon);
		this.SUBRULE(this.typeRef);
	});

	private declareDecl = this.RULE("declareDecl", () => {
		this.CONSUME(t.Declare);
		this.OR([
			{ ALT: () => this.SUBRULE(this.declareFunc) },
			{ ALT: () => this.SUBRULE(this.declareLet) },
			{
				GATE: () => this.LA(1).image === "type",
				ALT: () => this.SUBRULE(this.declareType),
			},
		]);
	});

	private declareFunc = this.RULE("declareFunc", () => {
		this.OPTION4(() => this.CONSUME(t.Async));
		this.CONSUME(t.Fn);
		this.CONSUME(t.Identifier);
		this.OPTION(() => this.SUBRULE(this.genericParams));
		this.CONSUME(t.LParen);
		this.OPTION2(() => this.SUBRULE(this.paramList));
		this.CONSUME(t.RParen);
		this.OPTION3(() => {
			this.CONSUME(t.Arrow);
			this.SUBRULE(this.typeRef);
		});
	});

	private declareLet = this.RULE("declareLet", () => {
		this.CONSUME(t.Let);
		this.CONSUME(t.Identifier);
		this.CONSUME(t.Colon);
		this.SUBRULE(this.typeRef);
	});

	private declareType = this.RULE("declareType", () => {
		this.CONSUME(t.Identifier, { LABEL: "typeKeyword" });
		this.CONSUME2(t.Identifier, { LABEL: "name" });
		this.OPTION(() => this.SUBRULE(this.genericParams));
		this.CONSUME(t.LCurly);
		this.MANY(() => this.SUBRULE(this.declareTypeMember));
		this.CONSUME(t.RCurly);
	});

	private declareTypeMember = this.RULE("declareTypeMember", () => {
		this.OR([
			{
				ALT: () => {
					this.OR2([
						{ ALT: () => this.CONSUME(t.Let) },
						{ ALT: () => this.CONSUME(t.Var) },
					]);
					this.CONSUME(t.Identifier);
					this.CONSUME(t.Colon);
					this.SUBRULE(this.typeRef);
				},
			},
			{
				GATE: () =>
					this.LA(1).tokenType === t.Fn ||
					this.LA(1).tokenType === t.Async ||
					(this.LA(1).image === "mutating" && this.LA(2).tokenType === t.Fn),
				ALT: () => {
					this.OPTION(() =>
						this.CONSUME2(t.Identifier, { LABEL: "mutatingKeyword" }),
					);
					this.OPTION4(() => this.CONSUME(t.Async));
					this.CONSUME(t.Fn);
					this.CONSUME3(t.Identifier, { LABEL: "methodName" });
					this.OPTION5(() => this.SUBRULE(this.genericParams));
					this.CONSUME(t.LParen);
					this.OPTION2(() => this.SUBRULE(this.paramList));
					this.CONSUME(t.RParen);
					this.OPTION6(() => {
						this.CONSUME(t.Arrow);
						this.SUBRULE2(this.typeRef);
					});
				},
			},
		]);
		this.OPTION3(() => this.CONSUME(t.Semicolon));
	});

	private ifStmt = this.RULE("ifStmt", () => {
		this.CONSUME(t.If);
		this.SUBRULE(this.conditionList);
		this.SUBRULE(this.block);
		this.OPTION(() => {
			this.CONSUME(t.Else);
			this.OR([
				{ ALT: () => this.SUBRULE(this.ifStmt) },
				{ ALT: () => this.SUBRULE2(this.block) },
			]);
		});
	});

	private guardStmt = this.RULE("guardStmt", () => {
		this.CONSUME(t.Guard);
		this.SUBRULE(this.conditionList);
		this.CONSUME(t.Else);
		this.SUBRULE(this.block);
	});

	private conditionList = this.RULE("conditionList", () => {
		this.SUBRULE(this.condition);
		this.MANY(() => {
			this.CONSUME(t.Comma);
			this.SUBRULE2(this.condition);
		});
	});

	private condition = this.RULE("condition", () => {
		this.OR([
			{
				ALT: () => {
					this.CONSUME(t.Let);
					this.CONSUME(t.Identifier);
					this.CONSUME(t.Equals);
					this.SUBRULE(this.condExpression);
				},
			},
			{ ALT: () => this.SUBRULE2(this.condExpression) },
		]);
	});

	private forStmt = this.RULE("forStmt", () => {
		this.CONSUME(t.For);
		this.OR2([
			{ ALT: () => this.CONSUME(t.Identifier, { LABEL: "single" }) },
			{
				ALT: () => {
					this.CONSUME(t.LParen);
					this.CONSUME2(t.Identifier, { LABEL: "tupleKey" });
					this.CONSUME(t.Comma);
					this.CONSUME3(t.Identifier, { LABEL: "tupleValue" });
					this.CONSUME(t.RParen);
				},
			},
		]);
		this.CONSUME(t.In);
		this.SUBRULE(this.condExpression, { LABEL: "source" });
		this.OPTION(() => {
			this.OR([
				{ ALT: () => this.CONSUME(t.RangeExcl) },
				{ ALT: () => this.CONSUME(t.RangeIncl) },
			]);
			this.SUBRULE2(this.condExpression, { LABEL: "rangeEnd" });
		});
		this.SUBRULE(this.block);
	});

	private whileStmt = this.RULE("whileStmt", () => {
		this.CONSUME(t.While);
		this.SUBRULE(this.condExpression);
		this.SUBRULE(this.block);
	});

	private switchStmt = this.RULE("switchStmt", () => {
		this.CONSUME(t.Switch);
		this.SUBRULE(this.condExpression);
		this.CONSUME(t.LCurly);
		this.MANY(() => this.SUBRULE(this.switchCase));
		this.CONSUME(t.RCurly);
	});

	private switchCase = this.RULE("switchCase", () => {
		this.OR([
			{
				ALT: () => {
					this.CONSUME(t.Case);
					this.SUBRULE(this.casePattern);
					this.CONSUME(t.Colon);
					this.MANY(() => this.SUBRULE(this.statement));
				},
			},
			{
				ALT: () => {
					this.CONSUME(t.Default);
					this.CONSUME2(t.Colon);
					this.MANY2(() => this.SUBRULE2(this.statement));
				},
			},
		]);
	});

	private casePattern = this.RULE("casePattern", () => {
		this.OR([
			{
				ALT: () => {
					this.CONSUME(t.Dot);
					this.CONSUME(t.Identifier, { LABEL: "caseName" });
					this.OPTION(() => {
						this.CONSUME(t.LParen);
						this.CONSUME(t.Let);
						this.CONSUME2(t.Identifier, { LABEL: "binding" });
						this.MANY(() => {
							this.CONSUME(t.Comma);
							this.CONSUME2(t.Let);
							this.CONSUME3(t.Identifier, { LABEL: "binding" });
						});
						this.CONSUME(t.RParen);
					});
				},
			},
			{
				ALT: () => {
					this.OPTION2(() => this.CONSUME(t.Minus));
					this.CONSUME(t.NumberLiteral);
				},
			},
			{ ALT: () => this.CONSUME(t.StringLiteral) },
			{ ALT: () => this.CONSUME(t.True) },
			{ ALT: () => this.CONSUME(t.False) },
			{
				ALT: () => {
					this.CONSUME(t.Is);
					this.SUBRULE(this.typeRef);
				},
			},
		]);
	});

	private returnStmt = this.RULE("returnStmt", () => {
		this.CONSUME(t.Return);
		this.OPTION(() => this.SUBRULE(this.expression));
	});

	private throwStmt = this.RULE("throwStmt", () => {
		this.CONSUME(t.Throw);
		this.SUBRULE(this.expression);
	});

	private doCatchStmt = this.RULE("doCatchStmt", () => {
		this.CONSUME(t.Do);
		this.SUBRULE(this.block);
		this.CONSUME(t.Catch);
		this.SUBRULE2(this.block, { LABEL: "catchBlock" });
	});

	private exprStatement = this.RULE("exprStatement", () => {
		this.SUBRULE(this.expression, { LABEL: "target" });
		this.OPTION(() => {
			this.OR([
				{ ALT: () => this.CONSUME(t.Equals) },
				{ ALT: () => this.CONSUME(t.PlusEq) },
				{ ALT: () => this.CONSUME(t.MinusEq) },
				{ ALT: () => this.CONSUME(t.StarEq) },
				{ ALT: () => this.CONSUME(t.SlashEq) },
			]);
			this.SUBRULE2(this.expression, { LABEL: "value" });
		});
	});

	private block = this.RULE("block", () => {
		this.CONSUME(t.LCurly);
		this.MANY(() => this.SUBRULE(this.statement));
		this.CONSUME(t.RCurly);
	});

	// ---- Expressions ----

	/** Expression in a statement-header position: trailing closures disabled. */
	private condExpression = this.RULE("condExpression", () => {
		this.condDepth++;
		try {
			this.SUBRULE(this.expression);
		} finally {
			this.condDepth--;
		}
	});

	public expression = this.RULE("expression", () => {
		this.SUBRULE(this.nilCoalesce, { LABEL: "cond" });
		this.OPTION(() => {
			this.CONSUME(t.Question);
			this.SUBRULE(this.expression, { LABEL: "then" });
			this.CONSUME(t.Colon);
			this.SUBRULE2(this.expression, { LABEL: "else" });
		});
	});

	private nilCoalesce = this.RULE("nilCoalesce", () => {
		this.SUBRULE(this.logicalOr);
		this.MANY(() => {
			this.CONSUME(t.NilCoalesce);
			this.SUBRULE2(this.logicalOr);
		});
	});

	private logicalOr = this.RULE("logicalOr", () => {
		this.SUBRULE(this.logicalAnd);
		this.MANY(() => {
			this.CONSUME(t.OrOr);
			this.SUBRULE2(this.logicalAnd);
		});
	});

	private logicalAnd = this.RULE("logicalAnd", () => {
		this.SUBRULE(this.equality);
		this.MANY(() => {
			this.CONSUME(t.AndAnd);
			this.SUBRULE2(this.equality);
		});
	});

	private equality = this.RULE("equality", () => {
		this.SUBRULE(this.comparison);
		this.OPTION(() => {
			this.OR([
				{ ALT: () => this.CONSUME(t.EqualsEquals) },
				{ ALT: () => this.CONSUME(t.NotEquals) },
			]);
			this.SUBRULE2(this.comparison);
		});
	});

	private comparison = this.RULE("comparison", () => {
		this.SUBRULE(this.additive);
		this.OPTION(() => {
			this.OR([
				{ ALT: () => this.CONSUME(t.Less) },
				{ ALT: () => this.CONSUME(t.LessEq) },
				{ ALT: () => this.CONSUME(t.Greater) },
				{ ALT: () => this.CONSUME(t.GreaterEq) },
			]);
			this.SUBRULE2(this.additive);
		});
	});

	private additive = this.RULE("additive", () => {
		this.SUBRULE(this.multiplicative);
		this.MANY(() => {
			this.OR([
				{ ALT: () => this.CONSUME(t.Plus) },
				{ ALT: () => this.CONSUME(t.Minus) },
			]);
			this.SUBRULE2(this.multiplicative);
		});
	});

	private multiplicative = this.RULE("multiplicative", () => {
		this.SUBRULE(this.castExpr);
		this.MANY(() => {
			this.OR([
				{ ALT: () => this.CONSUME(t.Star) },
				{ ALT: () => this.CONSUME(t.Slash) },
				{ ALT: () => this.CONSUME(t.Percent) },
			]);
			this.SUBRULE2(this.castExpr);
		});
	});

	/** `expr is Type` binds tighter than arithmetic, looser than unary. */
	private castExpr = this.RULE("castExpr", () => {
		this.SUBRULE(this.unaryExpr);
		this.OPTION(() => {
			this.CONSUME(t.Is);
			this.SUBRULE(this.typeRef);
		});
	});

	private unaryExpr = this.RULE("unaryExpr", () => {
		this.OR([
			{
				ALT: () => {
					this.CONSUME(t.Await);
					this.SUBRULE(this.unaryExpr);
				},
			},
			{
				ALT: () => {
					this.CONSUME(t.Try);
					this.SUBRULE3(this.unaryExpr);
				},
			},
			{
				ALT: () => {
					this.OR2([
						{ ALT: () => this.CONSUME(t.Bang) },
						{ ALT: () => this.CONSUME(t.Minus) },
					]);
					this.SUBRULE2(this.unaryExpr);
				},
			},
			{ ALT: () => this.SUBRULE(this.postfixExpr) },
		]);
	});

	private postfixExpr = this.RULE("postfixExpr", () => {
		this.SUBRULE(this.primaryExpr);
		this.MANY({
			GATE: () => this.condDepth === 0 || this.LA(1).tokenType !== t.LCurly,
			DEF: () => this.SUBRULE(this.postfixOp),
		});
	});

	private postfixOp = this.RULE("postfixOp", () => {
		this.OR([
			{ ALT: () => this.SUBRULE(this.callParens) },
			{
				GATE: () => this.condDepth === 0,
				ALT: () => this.SUBRULE(this.closureLiteral),
			},
			{
				ALT: () => {
					this.CONSUME(t.Dot);
					this.CONSUME(t.Identifier);
				},
			},
			{
				ALT: () => {
					this.CONSUME(t.OptionalChain);
					this.CONSUME2(t.Identifier);
				},
			},
			{
				ALT: () => {
					this.CONSUME(t.LBracket);
					this.SUBRULE(this.nestedExpression);
					this.CONSUME(t.RBracket);
				},
			},
			{ ALT: () => this.CONSUME(t.Bang) },
		]);
	});

	private callParens = this.RULE("callParens", () => {
		this.CONSUME(t.LParen);
		this.OPTION(() => {
			this.SUBRULE(this.callArg);
			this.MANY(() => {
				this.CONSUME(t.Comma);
				this.SUBRULE2(this.callArg);
			});
		});
		this.CONSUME(t.RParen);
	});

	private callArg = this.RULE("callArg", () => {
		// Argument labels may be keywords (Swift-style `move(from: x)`).
		this.OPTION({
			GATE: () =>
				(this.LA(1).tokenType === t.Identifier ||
					this.LA(1).tokenType === t.From ||
					this.LA(1).tokenType === t.Use) &&
				this.LA(2).tokenType === t.Colon,
			DEF: () => {
				this.OR([
					{ ALT: () => this.CONSUME(t.Identifier, { LABEL: "argLabel" }) },
					{ ALT: () => this.CONSUME(t.From, { LABEL: "argLabel" }) },
					{ ALT: () => this.CONSUME(t.Use, { LABEL: "argLabel" }) },
				]);
				this.CONSUME(t.Colon);
			},
		});
		this.SUBRULE(this.nestedExpression);
	});

	/** Expression in a nested bracket context: trailing closures re-enabled. */
	private nestedExpression = this.RULE("nestedExpression", () => {
		const saved = this.condDepth;
		this.condDepth = 0;
		try {
			this.SUBRULE(this.expression);
		} finally {
			this.condDepth = saved;
		}
	});

	private primaryExpr = this.RULE("primaryExpr", () => {
		this.OR([
			{ ALT: () => this.CONSUME(t.NumberLiteral) },
			{ ALT: () => this.CONSUME(t.StringLiteral) },
			{ ALT: () => this.CONSUME(t.Nil) },
			{ ALT: () => this.CONSUME(t.True) },
			{ ALT: () => this.CONSUME(t.False) },
			{ ALT: () => this.CONSUME(t.Super) },
			{ ALT: () => this.CONSUME(t.DollarIdent) },
			{ ALT: () => this.CONSUME(t.Identifier) },
			{
				ALT: () => {
					this.CONSUME(t.LParen);
					this.SUBRULE(this.nestedExpression);
					this.CONSUME(t.RParen);
				},
			},
			{
				GATE: this.BACKTRACK(this.dictLiteral),
				ALT: () => this.SUBRULE(this.dictLiteral),
			},
			{ ALT: () => this.SUBRULE(this.bracketLiteral) },
			{ ALT: () => this.SUBRULE(this.doExprLiteral) },
			{
				GATE: () => this.condDepth === 0,
				ALT: () => this.SUBRULE(this.closureLiteral),
			},
		]);
	});

	/** Value-producing `do { ... }` (optionally with `catch { ... }`). */
	private doExprLiteral = this.RULE("doExprLiteral", () => {
		this.CONSUME(t.Do);
		this.SUBRULE(this.block);
		this.OPTION(() => {
			this.CONSUME(t.Catch);
			this.SUBRULE2(this.block, { LABEL: "catchBlock" });
		});
	});

	/** Array literal `[a, b]`. */
	private bracketLiteral = this.RULE("bracketLiteral", () => {
		this.CONSUME(t.LBracket);
		this.OPTION(() => {
			this.SUBRULE(this.nestedExpression);
			this.MANY(() => {
				this.CONSUME(t.Comma);
				this.SUBRULE2(this.nestedExpression);
			});
		});
		this.CONSUME(t.RBracket);
	});

	/** Dictionary literal `[a: 1, "b": 2, [expr]: 3]` or the empty `[:]`. */
	private dictLiteral = this.RULE("dictLiteral", () => {
		this.CONSUME(t.LBracket);
		this.OR([
			{ ALT: () => this.CONSUME(t.Colon) },
			{
				ALT: () => {
					this.SUBRULE(this.dictEntry);
					this.MANY(() => {
						this.CONSUME(t.Comma);
						this.SUBRULE2(this.dictEntry);
					});
					this.OPTION(() => this.CONSUME2(t.Comma));
				},
			},
		]);
		this.CONSUME(t.RBracket);
	});

	private dictEntry = this.RULE("dictEntry", () => {
		this.OR([
			{ ALT: () => this.CONSUME(t.Identifier, { LABEL: "bareKey" }) },
			{ ALT: () => this.CONSUME(t.StringLiteral, { LABEL: "stringKey" }) },
			{
				ALT: () => {
					this.CONSUME(t.LBracket);
					this.SUBRULE(this.nestedExpression, { LABEL: "computedKey" });
					this.CONSUME(t.RBracket);
				},
			},
		]);
		this.CONSUME(t.Colon);
		this.SUBRULE2(this.nestedExpression, { LABEL: "entryValue" });
	});

	private closureLiteral = this.RULE("closureLiteral", () => {
		this.CONSUME(t.LCurly);
		this.OPTION({
			GATE: this.BACKTRACK(this.closureHeader),
			DEF: () => this.SUBRULE(this.closureHeader),
		});
		this.MANY(() => this.SUBRULE(this.statement));
		this.CONSUME(t.RCurly);
	});

	private closureHeader = this.RULE("closureHeader", () => {
		this.OR([
			{
				ALT: () => {
					this.CONSUME(t.LParen);
					this.OPTION(() => {
						this.SUBRULE(this.closureParam);
						this.MANY(() => {
							this.CONSUME(t.Comma);
							this.SUBRULE2(this.closureParam);
						});
					});
					this.CONSUME(t.RParen);
					this.OPTION2(() => {
						this.CONSUME(t.Arrow);
						this.SUBRULE(this.typeRef);
					});
					this.CONSUME(t.In);
				},
			},
			{
				ALT: () => {
					this.CONSUME(t.Identifier);
					this.MANY2(() => {
						this.CONSUME2(t.Comma);
						this.CONSUME2(t.Identifier);
					});
					this.CONSUME2(t.In);
				},
			},
		]);
	});

	private closureParam = this.RULE("closureParam", () => {
		this.CONSUME(t.Identifier);
		this.OPTION(() => {
			this.CONSUME(t.Colon);
			this.SUBRULE(this.typeRef);
		});
	});

	// ---- Types ----

	public typeRef = this.RULE("typeRef", () => {
		this.SUBRULE(this.typeMember, { LABEL: "member" });
		this.MANY(() => {
			this.CONSUME(t.Pipe);
			this.SUBRULE2(this.typeMember, { LABEL: "member" });
		});
	});

	private typeMember = this.RULE("typeMember", () => {
		this.SUBRULE(this.typePrimary);
		// `??` lexes as the nil-coalescing token but is exactly two `?`
		// suffixes in type position (`Number??`).
		this.MANY(() =>
			this.OR([
				{ ALT: () => this.CONSUME(t.Question) },
				{ ALT: () => this.CONSUME(t.NilCoalesce) },
			]),
		);
	});

	private typePrimary = this.RULE("typePrimary", () => {
		this.OR([
			{
				ALT: () => {
					this.CONSUME(t.Identifier);
					this.OPTION(() => this.SUBRULE(this.typeArgs));
				},
			},
			{
				ALT: () => {
					this.CONSUME(t.LParen);
					this.OPTION2(() => {
						this.SUBRULE(this.typeRef);
						this.MANY(() => {
							this.CONSUME(t.Comma);
							this.SUBRULE2(this.typeRef);
						});
					});
					this.CONSUME(t.RParen);
					this.OPTION3(() => {
						this.CONSUME(t.Arrow);
						this.SUBRULE3(this.typeRef, { LABEL: "ret" });
					});
				},
			},
			{
				// `[T]` (Array) sugar / `[K: V]` dictionary type
				ALT: () => {
					this.CONSUME(t.LBracket);
					this.SUBRULE4(this.typeRef, { LABEL: "bracketElement" });
					this.OPTION4(() => {
						this.CONSUME(t.Colon);
						this.SUBRULE6(this.typeRef, { LABEL: "dictValue" });
					});
					this.CONSUME(t.RBracket);
				},
			},
			// Literal types
			{
				ALT: () => {
					this.OPTION5(() => this.CONSUME(t.Minus));
					this.CONSUME(t.NumberLiteral);
				},
			},
			{ ALT: () => this.CONSUME(t.StringLiteral) },
			{ ALT: () => this.CONSUME(t.True) },
			{ ALT: () => this.CONSUME(t.False) },
		]);
	});

	private typeArgs = this.RULE("typeArgs", () => {
		this.CONSUME(t.Less);
		this.SUBRULE(this.typeRef);
		this.MANY(() => {
			this.CONSUME(t.Comma);
			this.SUBRULE2(this.typeRef);
		});
		this.CONSUME(t.Greater);
	});
}

export const syrupParser = new SyrupParser();
