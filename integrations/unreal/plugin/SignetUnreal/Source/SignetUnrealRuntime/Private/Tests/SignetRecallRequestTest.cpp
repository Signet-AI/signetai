#if WITH_DEV_AUTOMATION_TESTS

#include "SignetRecallRequest.h"

#include "HAL/PlatformMisc.h"
#include "Json.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FSignetRecallRequestContractTest,
	"Signet.Recall.RequestContract",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter
)

bool FSignetRecallRequestContractTest::RunTest(const FString& Parameters)
{
	(void)Parameters;
	const FString ContractPath = FPlatformMisc::GetEnvironmentVariable(TEXT("SIGNET_RECALL_CONTRACT_VECTORS"));
	if (ContractPath.IsEmpty())
	{
		AddWarning(TEXT("Skipping Signet recall contract test because SIGNET_RECALL_CONTRACT_VECTORS is not set"));
		return true;
	}

	FString ContractJson;
	if (!FFileHelper::LoadFileToString(ContractJson, *ContractPath))
	{
		AddError(FString::Printf(TEXT("Unable to read recall contract: %s"), *ContractPath));
		return false;
	}

	TSharedPtr<FJsonObject> Contract;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ContractJson);
	if (!FJsonSerializer::Deserialize(Reader, Contract) || !Contract.IsValid())
	{
		AddError(TEXT("Recall contract is not valid JSON"));
		return false;
	}

	const TSharedPtr<FJsonObject> Overrides = Contract->GetObjectField(TEXT("overrides"));
	const TSharedPtr<FJsonObject> Unreal = Overrides->GetObjectField(TEXT("unreal"));
	TestEqual(TEXT("Default NPC limit matches the shared contract"), SignetRecallRequest::DefaultNpcLimit, static_cast<int32>(Unreal->GetNumberField(TEXT("defaultLimit"))));
	TestEqual(TEXT("Minimum NPC limit matches the shared contract"), SignetRecallRequest::MinimumNpcLimit, static_cast<int32>(Unreal->GetNumberField(TEXT("minimumLimit"))));
	TestEqual(TEXT("Maximum NPC limit matches the shared contract"), SignetRecallRequest::MaximumNpcLimit, static_cast<int32>(Unreal->GetNumberField(TEXT("maximumLimit"))));
	TestTrue(TEXT("NPC recalls include rows recalled earlier in the context"), Unreal->GetBoolField(TEXT("includeRecalled")));

	const TSharedRef<FJsonObject> Body = SignetRecallRequest::BuildNpcBody(
		TEXT("npc-1"),
		TEXT("world:alpha"),
		TEXT("What happened here?"),
		5000
	);
	TestEqual(TEXT("Query is serialized"), Body->GetStringField(TEXT("query")), FString(TEXT("What happened here?")));
	TestEqual(TEXT("Agent is serialized"), Body->GetStringField(TEXT("agentId")), FString(TEXT("npc-1")));
	TestEqual(TEXT("Custom world scope is preserved"), Body->GetStringField(TEXT("scope")), FString(TEXT("world:alpha")));
	TestEqual(TEXT("NPC limit is clamped"), static_cast<int32>(Body->GetNumberField(TEXT("limit"))), SignetRecallRequest::MaximumNpcLimit);
	TestTrue(TEXT("includeRecalled is serialized"), Body->GetBoolField(TEXT("includeRecalled")));
	return true;
}

#endif
