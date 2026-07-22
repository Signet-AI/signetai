#include "SignetRecallRequest.h"

namespace SignetRecallRequest
{
TSharedRef<FJsonObject> BuildNpcBody(
	const FString& AgentId,
	const FString& Scope,
	const FString& Query,
	int32 Limit
)
{
	TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("query"), Query);
	Body->SetStringField(TEXT("agentId"), AgentId);
	Body->SetStringField(TEXT("scope"), Scope);
	Body->SetNumberField(TEXT("limit"), FMath::Clamp(Limit, MinimumNpcLimit, MaximumNpcLimit));
	Body->SetBoolField(TEXT("includeRecalled"), true);
	return Body;
}
}
