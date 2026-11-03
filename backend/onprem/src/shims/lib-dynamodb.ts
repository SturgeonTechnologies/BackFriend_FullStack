// Same command classes the handlers import from @aws-sdk/lib-dynamodb.
export class Command {
  constructor(public readonly input: any) {}
}
export class GetCommand extends Command {}
export class PutCommand extends Command {}
export class UpdateCommand extends Command {}
export class DeleteCommand extends Command {}
export class ScanCommand extends Command {}
export class QueryCommand extends Command {}
