#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintAsyncActionBase.h"
#include "SignetUnrealTypes.h"
#include "SignetAsyncActions.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FSignetOperationCompleted, const FSignetOperationResult&, Result);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(
	FSignetRecallCompleted,
	const FSignetOperationResult&,
	Result,
	const FSignetRecallContext&,
	Context
);

UCLASS()
class SIGNETUNREALRUNTIME_API USignetHealthCheckAsync : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	UPROPERTY(BlueprintAssignable)
	FSignetOperationCompleted Completed;

	UFUNCTION(BlueprintCallable, meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject"), Category = "Signet")
	static USignetHealthCheckAsync* SignetHealthCheck(UObject* WorldContextObject);

	virtual void Activate() override;

private:
	UPROPERTY()
	TObjectPtr<UObject> WorldContext;
};

UCLASS()
class SIGNETUNREALRUNTIME_API USignetRegisterNpcAgentAsync : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	UPROPERTY(BlueprintAssignable)
	FSignetOperationCompleted Completed;

	UFUNCTION(BlueprintCallable, meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject"), Category = "Signet")
	static USignetRegisterNpcAgentAsync* RegisterSignetNpcAgent(UObject* WorldContextObject, FSignetNpcIdentity Identity);

	virtual void Activate() override;

private:
	UPROPERTY()
	TObjectPtr<UObject> WorldContext;

	UPROPERTY()
	FSignetNpcIdentity Identity;
};

UCLASS()
class SIGNETUNREALRUNTIME_API USignetObserveNpcEventAsync : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	UPROPERTY(BlueprintAssignable)
	FSignetOperationCompleted Completed;

	UFUNCTION(BlueprintCallable, meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject"), Category = "Signet")
	static USignetObserveNpcEventAsync* ObserveNpcEvent(UObject* WorldContextObject, FSignetNpcEvent Event);

	virtual void Activate() override;

private:
	UPROPERTY()
	TObjectPtr<UObject> WorldContext;

	UPROPERTY()
	FSignetNpcEvent Event;
};

UCLASS()
class SIGNETUNREALRUNTIME_API USignetRecallNpcContextAsync : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	UPROPERTY(BlueprintAssignable)
	FSignetRecallCompleted Completed;

	UFUNCTION(BlueprintCallable, meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject"), Category = "Signet")
	static USignetRecallNpcContextAsync* RecallNpcContext(
		UObject* WorldContextObject,
		const FString& AgentId,
		const FString& WorldId,
		const FString& PlayerId,
		const FString& Situation,
		int32 Limit
	);

	virtual void Activate() override;

private:
	UPROPERTY()
	TObjectPtr<UObject> WorldContext;

	UPROPERTY()
	FString AgentId;

	UPROPERTY()
	FString WorldId;

	UPROPERTY()
	FString PlayerId;

	UPROPERTY()
	FString Situation;

	UPROPERTY()
	int32 Limit = 6;

	TArray<FSignetMemoryBlock> PendingMemories;
	void RecallScope(const FString& Scope, TFunction<void(const FSignetOperationResult&)> Done);
	void FinishRecall(const FSignetOperationResult& Result);
};
